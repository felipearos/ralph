#!/usr/bin/env bun
/**
 * The clerk's Slack client: the Web API calls the clerk makes, through an
 * injected `fetch`, so every test runs against a fake and never the network.
 *
 * Every call ends in a value or a `SlackError` whose `failure` says which of
 * three things went wrong, because each one is handled differently and none of
 * them may hang or halt a loop left running overnight:
 *
 * - `transient` — a 5xx, a timeout, a network error, or an error code Slack
 *   documents as a hiccup. Nothing is lost by waiting: the gate reads no work
 *   this poll and backs off.
 * - `rate-limited` — HTTP 429. Slack says how long in `Retry-After`, and the
 *   gate waits exactly that rather than its own guess.
 * - `denied` — the token is invalid or revoked, it lacks a scope, or the bot is
 *   not in the channel. No amount of waiting fixes these, so the gate stops the
 *   loop with the remedy and a notification instead of retrying forever.
 *
 * The token is `RALPH_CLERK_SLACK_TOKEN`, a bot token (`xoxb-…`) of a Slack app
 * made for the clerk. It is a `gate` secret (`roles.ts`): the supervisor hands
 * it to the clerk's gate alone, after `--check-token` has proved it, and no
 * model session ever holds it. Nothing here prints it.
 *
 * Usage:
 *   bun clerk/slack.ts --check-token   is the token valid, with every scope the clerk needs?
 *
 * Exit codes for `--check-token`: 0 usable, or Slack could not be asked (the
 * gate re-checks on every poll) · 1 refused (named) · 64 usage.
 */
import { createWriteStream } from "node:fs";
import { once } from "node:events";

import { projectRoot } from "../paths";
import { clerkRules, loadProjectConfig, type ClerkMode } from "../project-config";

/** The Web API's base. */
export const SLACK_API = "https://slack.com/api";

/** The secret the supervisor reads by name and hands to the gate. */
export const SLACK_TOKEN_ENV = "RALPH_CLERK_SLACK_TOKEN";

/**
 * The scopes the clerk's bot needs, as the spec decides them (felipearos/ralph#315):
 * reading the channel and its threads, naming reporters, rebuilding a canvas
 * and replying in a thread. `files:read` is not among them: it is what copies
 * a report's files onto its ticket (`FILES_SCOPE`), and a token without it
 * still files every report, with the files linked.
 */
export const REQUIRED_SCOPES = [
  "channels:history",
  "channels:read",
  "users:read",
  "canvases:read",
  "canvases:write",
  "chat:write",
] as const;

/**
 * The scopes of those that write: a quiet clerk (felipearos/ralph#443) posts
 * nothing in the channel, so its token is not refused without them. The
 * operator's test canvas and the KPI draft do need them, and say so when
 * Slack refuses.
 */
export const WRITE_SCOPES = ["canvases:write", "chat:write"] as const;

/**
 * The scopes the daily KPI DM needs on top of those (felipearos/ralph#453):
 * opening a DM and posting in it, and reading the members of a public or a
 * private intake channel. Optional, because the report is not what the clerk
 * is for: the token check names the missing ones as a warning, and the gate
 * logs a refused report and carries on.
 */
export const KPI_SCOPES = ["im:write", "chat:write", "channels:read", "groups:read"] as const;

/**
 * The scope that downloads a report's files to attach them to its ticket
 * (`clerk/attachments.ts`). A warning when missing, never a refusal: the
 * ticket is filed either way, and the files wait, linked, until it is added.
 */
export const FILES_SCOPE = "files:read";

/** How long one call may take before it counts as a transient failure. */
export const CALL_TIMEOUT_MS = 20_000;

/**
 * How long one file download may take: a 100 MB video on a slow link, and no
 * longer, so a stalled download is a retry later rather than a hung poll.
 */
export const FILE_TIMEOUT_MS = 10 * 60_000;

/** What a download did: the file is at `dest`, or it was bigger than allowed and nothing was kept. */
export type Downloaded = { kind: "saved"; bytes: number } | { kind: "too-large"; bytes: number };

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type SlackFailure =
  /** `code` is Slack's own error code when it answered with one, so a caller can tell a known `ok: false` apart. */
  | { kind: "transient"; why: string; code?: string }
  | { kind: "rate-limited"; why: string; retryAfterSeconds: number }
  | { kind: "denied"; code: string; why: string; remedy: string };

export class SlackError extends Error {
  constructor(readonly failure: SlackFailure) {
    super(failure.why);
    this.name = "SlackError";
  }
}

/**
 * The error codes that are a setup fault rather than a bad moment, and what an
 * operator does about each. Matched exactly: an unknown code is transient, so a
 * code Slack adds later backs off instead of stopping a loop it may not need to.
 */
const DENIALS: Readonly<Record<string, (detail: { needed?: string; channel: string }) => string>> = {
  invalid_auth: () => `store a valid bot token (xoxb-…) as ${SLACK_TOKEN_ENV} and restart`,
  not_authed: () => `store a valid bot token (xoxb-…) as ${SLACK_TOKEN_ENV} and restart`,
  token_revoked: () => `the token was revoked: reinstall the clerk's Slack app, store its new bot token as ${SLACK_TOKEN_ENV}, and restart`,
  token_expired: () => `the token expired: store a fresh bot token as ${SLACK_TOKEN_ENV} and restart`,
  account_inactive: () => `the bot's account is deactivated: reinstall the clerk's Slack app, store its bot token as ${SLACK_TOKEN_ENV}, and restart`,
  missing_scope: ({ needed }) =>
    `add ${needed ? `the ${needed} scope` : "the missing scope"} to the clerk's Slack app, reinstall it, store the new bot token as ${SLACK_TOKEN_ENV}, and restart`,
  not_in_channel: ({ channel }) => `invite the clerk's bot to ${channel} (/invite in the channel) and restart`,
  channel_not_found: ({ channel }) => `check 'clerk.channel' (${channel}) in .ralph/config.json; a private channel also needs the bot invited`,
  is_archived: ({ channel }) => `${channel} is archived: unarchive it or point 'clerk.channel' at the reports channel, and restart`,
};

export const isDenial = (code: string): boolean => Object.hasOwn(DENIALS, code);

/**
 * What a canvas call answers when the canvas was deleted or the bot can no
 * longer reach it. None of them is a denial: the token is fine and so is the
 * channel, only one canvas is gone, and the view heals itself by being created
 * again (felipearos/ralph#315, "a deleted canvas … is recreated"). Stopping a
 * loop over it would trade a missing table for missing tickets.
 */
export const CANVAS_GONE: ReadonlySet<string> = new Set([
  "canvas_not_found",
  "canvas_deleted",
  "access_denied",
  "no_permission",
  "not_found",
  "file_not_found",
  "file_deleted",
]);

/** What a 429's `Retry-After` asks for, in whole seconds; a minute when it says nothing usable. */
export function retryAfterSeconds(header: string | null): number {
  const seconds = header === null ? NaN : Number(header.trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60;
}

export interface AuthIdentity {
  /** The bot's own user id, whose messages are never reports. */
  userId: string;
  botId: string | null;
  /** The workspace's URL, `https://<team>.slack.com/`, which permalinks are built from. */
  url: string;
  team: string;
  /** The scopes the token was granted (`x-oauth-scopes`). */
  scopes: string[];
}

/** One message as `conversations.history` and `conversations.replies` return it, trimmed to what the clerk reads. */
export interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  files?: SlackFile[];
}

/** A file on a message, trimmed to what the clerk reads (`files:read` is what lets the bot download it). */
export interface SlackFile {
  id?: string;
  name?: string;
  permalink?: string;
  /** Bytes, as Slack reports them. */
  size?: number;
  mimetype?: string;
  /** Where the bot downloads it from, with its token as a bearer. */
  url_private_download?: string;
  /** `hosted`, `external` (a link to another service), `tombstone` (deleted), … */
  mode?: string;
}

export interface SlackClient {
  authTest(): Promise<AuthIdentity>;
  /** Top-level messages after `oldest` (exclusive), oldest first, every page read. */
  history(channel: string, oldest: string): Promise<SlackMessage[]>;
  /** A thread, parent first, then the replies oldest first. */
  replies(channel: string, ts: string): Promise<SlackMessage[]>;
  /** A user's name as Slack shows it: display name, else real name, else handle. */
  userName(user: string): Promise<string>;
  /** Post `text` as a reply in the thread under `threadTs`; the reply's ts. */
  postReply(channel: string, threadTs: string, text: string): Promise<string>;
  /**
   * Replace a canvas's whole document with `markdown`. `gone` when the canvas
   * was deleted or the bot lost access (`CANVAS_GONE`): the caller creates
   * another rather than failing.
   */
  replaceCanvas(canvas: string, markdown: string): Promise<"replaced" | "gone">;
  /** Create a standalone canvas holding `markdown`, and return its id. */
  createCanvas(title: string, markdown: string): Promise<string>;
  /** Let `user` open and edit `canvas`: a canvas the bot creates is the bot's alone until it is shared. */
  shareCanvas(canvas: string, user: string): Promise<void>;
  /** Create `channel`'s own canvas holding `markdown`, and return its id. A channel has at most one. */
  createChannelCanvas(channel: string, markdown: string): Promise<string>;
  /** The id of `channel`'s own canvas, or null when it has none (`conversations.info`). */
  channelCanvasOf(channel: string): Promise<string | null>;
  /**
   * Whether the bot is a member of `channel` (`conversations.info`), which a
   * top-level post there needs. Throws as any call does, `channel_not_found`
   * included, which is what a private channel answers a bot not in it.
   */
  isChannelMember(channel: string): Promise<boolean>;
  /** Every member of `channel`, bots included (`conversations.members`, every page read). */
  channelMembers(channel: string): Promise<string[]>;
  /** Whether `user` is a bot (Slackbot included), from `users.info`. */
  isBot(user: string): Promise<boolean>;
  /** The bot's DM with `user`, opened if it was not (`conversations.open`); its channel id. */
  openDm(user: string): Promise<string>;
  /** Post `text` as a top-level message in `channel`; the message's ts. */
  postMessage(channel: string, text: string): Promise<string>;
  /**
   * Download a file's `url_private_download` to `dest`, streamed, stopping at
   * `maxBytes`. Only reads, so quiet mode may call it; it is not in the
   * thread watch's reader because the watch has no use for it.
   */
  downloadFile(url: string, dest: string, maxBytes: number): Promise<Downloaded>;
}

/** The calls that only read: what the thread watch is handed, so it can post nothing. */
export type SlackReader = Pick<SlackClient, "authTest" | "history" | "replies" | "userName" | "channelCanvasOf" | "channelMembers" | "isBot">;

/** A view of `slack` with its reads alone, as `clerk/confirm.ts` `readOnly` is of Jira. */
export const slackReader = (slack: SlackClient): SlackReader => ({
  authTest: () => slack.authTest(),
  history: (channel, oldest) => slack.history(channel, oldest),
  replies: (channel, ts) => slack.replies(channel, ts),
  userName: (user) => slack.userName(user),
  channelCanvasOf: (channel) => slack.channelCanvasOf(channel),
  channelMembers: (channel) => slack.channelMembers(channel),
  isBot: (user) => slack.isBot(user),
});

/**
 * Bounds a page loop: 10,000 messages. `conversations.history` pages from the
 * newest back towards `oldest`, so a read cut short drops the OLDEST messages
 * after the cursor — exactly the ones the cursor would then move past for good.
 * A read that hits the bound is therefore not a short read but a failure
 * (transient: nothing handed over, the cursor left where it is), and a reports
 * channel that busy is one an operator should hear about from the backoff.
 */
const MAX_PAGES = 50;

export function slackClient(token: string, fetcher: Fetch = fetch, channelForRemedy = "the channel"): SlackClient {
  /**
   * One Web API call. Reads go as GET with query parameters; a call given a
   * `json` body goes as POST, which the canvas methods need for their nested
   * `document_content`. Both end in the same classification below, so a write
   * fails exactly as a read does.
   */
  const call = async (
    method: string,
    params: Record<string, string>,
    json?: Record<string, unknown>,
  ): Promise<{ body: Record<string, unknown>; headers: Headers }> => {
    let response: Response;
    try {
      response = await fetcher(
        json === undefined ? `${SLACK_API}/${method}?${new URLSearchParams(params)}` : `${SLACK_API}/${method}`,
        json === undefined
          ? { method: "GET", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }
          : {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
              body: JSON.stringify(json),
              signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
            },
      );
    } catch (error) {
      // A timeout, a refused connection, a DNS failure: all of them are "not
      // now", and none of them says anything about the token.
      throw new SlackError({ kind: "transient", why: `Slack ${method} could not be reached: ${(error as Error).message}` });
    }
    if (response.status === 429) {
      const wait = retryAfterSeconds(response.headers.get("retry-after"));
      throw new SlackError({ kind: "rate-limited", why: `Slack ${method} is rate limited for ${wait}s`, retryAfterSeconds: wait });
    }
    if (response.status >= 500 || response.status === 408) {
      throw new SlackError({ kind: "transient", why: `Slack ${method} answered HTTP ${response.status}` });
    }
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new SlackError({ kind: "transient", why: `Slack ${method} answered HTTP ${response.status} with a body that is not JSON` });
    }
    if (body.ok !== true) {
      const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
      const remedy = DENIALS[code];
      if (remedy !== undefined) {
        const needed = typeof body.needed === "string" ? body.needed : undefined;
        throw new SlackError({
          kind: "denied",
          code,
          why: `Slack ${method} refused the clerk: ${code}${needed ? ` (needs ${needed})` : ""}`,
          remedy: remedy({ needed, channel: channelForRemedy }),
        });
      }
      if (code === "ratelimited") {
        const wait = retryAfterSeconds(response.headers.get("retry-after"));
        throw new SlackError({ kind: "rate-limited", why: `Slack ${method} is rate limited for ${wait}s`, retryAfterSeconds: wait });
      }
      throw new SlackError({ kind: "transient", why: `Slack ${method} failed: ${code}`, code });
    }
    return { body, headers: response.headers };
  };

  const pages = async (method: string, params: Record<string, string>): Promise<SlackMessage[]> => {
    const out: SlackMessage[] = [];
    let cursor = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const { body } = await call(method, { ...params, limit: "200", ...(cursor === "" ? {} : { cursor }) });
      if (Array.isArray(body.messages)) out.push(...(body.messages as SlackMessage[]));
      const next = (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
      if (body.has_more !== true || next === "") return out;
      cursor = next;
    }
    throw new SlackError({ kind: "transient", why: `Slack ${method} has more than ${MAX_PAGES * 200} messages to read in one poll` });
  };

  return {
    async authTest() {
      const { body, headers } = await call("auth.test", {});
      return {
        userId: String(body.user_id ?? ""),
        botId: typeof body.bot_id === "string" ? body.bot_id : null,
        url: String(body.url ?? ""),
        team: String(body.team ?? ""),
        scopes: (headers.get("x-oauth-scopes") ?? "")
          .split(",")
          .map((scope) => scope.trim())
          .filter((scope) => scope !== ""),
      };
    },
    async history(channel, oldest) {
      // Newest first from the API; the clerk reads a channel in the order it was written.
      const messages = await pages("conversations.history", { channel, oldest });
      return messages.filter((message) => typeof message.ts === "string").sort((a, b) => compareTs(a.ts, b.ts));
    },
    async replies(channel, ts) {
      const messages = await pages("conversations.replies", { channel, ts });
      return messages.filter((message) => typeof message.ts === "string").sort((a, b) => compareTs(a.ts, b.ts));
    },
    async postReply(channel, threadTs, text) {
      // `unfurl_links` off: a reply naming a ticket must not grow a preview
      // card of whatever the reporter linked.
      const { body } = await call("chat.postMessage", {}, { channel, thread_ts: threadTs, text, unfurl_links: false, unfurl_media: false });
      return String(body.ts ?? "");
    },
    async userName(user) {
      const { body } = await call("users.info", { user });
      const profile = (body.user ?? {}) as { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };
      return profile.profile?.display_name || profile.profile?.real_name || profile.real_name || profile.name || user;
    },
    async replaceCanvas(canvas, markdown) {
      try {
        // No `section_id`: the change replaces the whole document, so what the
        // canvas shows is exactly the last rebuild and nothing older.
        await call("canvases.edit", {}, { canvas_id: canvas, changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }] });
        return "replaced";
      } catch (error) {
        if (error instanceof SlackError && error.failure.kind === "transient" && CANVAS_GONE.has(error.failure.code ?? "")) return "gone";
        throw error;
      }
    },
    async createCanvas(title, markdown) {
      const { body } = await call("canvases.create", {}, { title, document_content: { type: "markdown", markdown } });
      if (typeof body.canvas_id !== "string" || body.canvas_id === "") {
        throw new SlackError({ kind: "transient", why: "Slack canvases.create answered ok with no canvas_id" });
      }
      return body.canvas_id;
    },
    async channelCanvasOf(channel) {
      const { body } = await call("conversations.info", { channel });
      const id = (body.channel as { properties?: { canvas?: { file_id?: unknown } } } | undefined)?.properties?.canvas?.file_id;
      return typeof id === "string" && id !== "" ? id : null;
    },
    async isChannelMember(channel) {
      const { body } = await call("conversations.info", { channel });
      // Only an explicit false: a channel Slack answers without the flag is one the bot could read.
      return (body.channel as { is_member?: unknown } | undefined)?.is_member !== false;
    },
    async createChannelCanvas(channel, markdown) {
      const { body } = await call("conversations.canvases.create", {}, { channel_id: channel, document_content: { type: "markdown", markdown } });
      if (typeof body.canvas_id !== "string" || body.canvas_id === "") {
        throw new SlackError({ kind: "transient", why: "Slack conversations.canvases.create answered ok with no canvas_id" });
      }
      return body.canvas_id;
    },
    async shareCanvas(canvas, user) {
      await call("canvases.access.set", {}, { canvas_id: canvas, access_level: "write", user_ids: [user] });
    },
    async channelMembers(channel) {
      const out: string[] = [];
      let cursor = "";
      for (let page = 0; page < MAX_PAGES; page++) {
        const { body } = await call("conversations.members", { channel, limit: "200", ...(cursor === "" ? {} : { cursor }) });
        if (Array.isArray(body.members)) out.push(...body.members.filter((member): member is string => typeof member === "string"));
        const next = (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
        if (next === "") return out;
        cursor = next;
      }
      throw new SlackError({ kind: "transient", why: `Slack conversations.members has more than ${MAX_PAGES * 200} members to read` });
    },
    async isBot(user) {
      if (user === "USLACKBOT") return true;
      const { body } = await call("users.info", { user });
      return (body.user as { is_bot?: unknown } | undefined)?.is_bot === true;
    },
    async openDm(user) {
      const { body } = await call("conversations.open", {}, { users: user });
      const id = (body.channel as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string" || id === "") throw new SlackError({ kind: "transient", why: "Slack conversations.open answered ok with no channel id" });
      return id;
    },
    async postMessage(channel, text) {
      const { body } = await call("chat.postMessage", {}, { channel, text, unfurl_links: false, unfurl_media: false });
      return String(body.ts ?? "");
    },
    downloadFile: (url, dest, maxBytes) => downloadFile(token, fetcher, url, dest, maxBytes),
  };
}

/**
 * One file, streamed to disk: a 100 MB video never sits in memory whole. A
 * file past `maxBytes` — by its `content-length`, or by what has arrived — is
 * dropped as soon as that is known, and the partial file is the caller's to
 * remove. Every failure is transient: a download is never a reason to stop
 * the loop, only to try that file again later.
 */
async function downloadFile(token: string, fetcher: Fetch, url: string, dest: string, maxBytes: number): Promise<Downloaded> {
  let response: Response;
  try {
    // `follow`: Slack serves a file from files.slack.com and may redirect it on.
    response = await fetcher(url, { method: "GET", headers: { authorization: `Bearer ${token}` }, redirect: "follow", signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
  } catch (error) {
    throw new SlackError({ kind: "transient", why: `the Slack file could not be downloaded: ${(error as Error).message}` });
  }
  const drop = async (): Promise<void> => {
    try {
      await response.body?.cancel();
    } catch {}
  };
  if (response.status === 429) {
    await drop();
    const wait = retryAfterSeconds(response.headers.get("retry-after"));
    throw new SlackError({ kind: "rate-limited", why: `Slack file downloads are rate limited for ${wait}s`, retryAfterSeconds: wait });
  }
  if (response.status < 200 || response.status >= 300) {
    await drop();
    throw new SlackError({ kind: "transient", why: `the Slack file download answered HTTP ${response.status}`, code: `http_${response.status}` });
  }
  // Without `files:read`, or for a file the bot cannot see, Slack answers
  // its sign-in page with a 200 rather than an error.
  if ((response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) {
    await drop();
    throw new SlackError({
      kind: "transient",
      why: `Slack answered a sign-in page instead of the file: the token lacks ${FILES_SCOPE}, or the bot cannot see the file`,
      code: "file_sign_in_page",
    });
  }
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await drop();
    return { kind: "too-large", bytes: declared };
  }
  if (response.body === null) throw new SlackError({ kind: "transient", why: "the Slack file download answered no body" });
  const out = createWriteStream(dest);
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return { kind: "too-large", bytes };
      }
      if (!out.write(value)) await once(out, "drain");
    }
  } catch (error) {
    throw new SlackError({ kind: "transient", why: `the Slack file download broke off: ${(error as Error).message}` });
  } finally {
    await new Promise<void>((done) => out.end(() => done()));
  }
  return { kind: "saved", bytes };
}

/**
 * Slack timestamps are `<seconds>.<micro>` strings, and comparing them as
 * floats loses the last digits; compared as two integers they are exact.
 */
export function compareTs(a: string, b: string): number {
  const [aSeconds = "0", aMicro = "0"] = a.split(".");
  const [bSeconds = "0", bMicro = "0"] = b.split(".");
  return Number(aSeconds) - Number(bSeconds) || Number(aMicro.padEnd(6, "0")) - Number(bMicro.padEnd(6, "0"));
}

/** A Slack timestamp as epoch milliseconds. */
export const tsMs = (ts: string): number => Math.floor(Number(ts) * 1000);

/** Epoch milliseconds as a Slack timestamp. */
export const msTs = (ms: number): string => `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, "0")}`;

/**
 * The scopes a token is missing, of the ones the clerk needs. Slack reports
 * granted scopes on every response; `auth.test` is the one call that needs no
 * scope of its own, so it can always be asked.
 */
export const missingScopes = (granted: readonly string[], mode: ClerkMode = "live"): string[] =>
  REQUIRED_SCOPES.filter((scope) => !granted.includes(scope) && (mode !== "quiet" || !(WRITE_SCOPES as readonly string[]).includes(scope)));

/** The KPI report's scopes the token lacks: a warning, not a refusal. */
export const missingKpiScopes = (granted: readonly string[]): string[] => KPI_SCOPES.filter((scope) => !granted.includes(scope));

/**
 * `--check-token`: the token authenticates and carries every scope the clerk
 * needs. The supervisor runs this before handing the token to the gate, and
 * withholds it on any refusal — which the preflight then reports as a denial.
 */
export async function checkToken(
  env: NodeJS.ProcessEnv,
  fetcher: Fetch = fetch,
  mode: ClerkMode = "live",
  kpiChannels: readonly string[] = [],
): Promise<{ code: number; message: string }> {
  const token = env.RALPH_CLERK_SLACK_TOKEN?.trim() ?? "";
  if (token === "") return { code: 1, message: `clerk-slack: no ${SLACK_TOKEN_ENV} in the environment` };
  let identity: AuthIdentity;
  const client = slackClient(token, fetcher);
  try {
    identity = await client.authTest();
  } catch (error) {
    if (error instanceof SlackError && error.failure.kind === "denied") {
      return { code: 1, message: `clerk-slack: ${error.failure.why}; ${error.failure.remedy}` };
    }
    // Slack could not be asked — a timeout, a 5xx, a 429. That proves nothing
    // either way, and `ralph.sh` withholds a token whose check exits non-zero,
    // which the preflight then DENIES: a blip at start would stop a loop meant
    // to run all night. So it passes, saying so, and the gate settles it: every
    // poll asks `auth.test` again, and a real refusal there stops the loop
    // with the remedy.
    const why = error instanceof SlackError ? error.failure.why : (error as Error).message;
    return { code: 0, message: `clerk-slack: Slack could not be reached to prove the token (${why}); the gate checks it on every poll` };
  }
  const missing = missingScopes(identity.scopes, mode);
  if (missing.length > 0) {
    return {
      code: 1,
      message: `clerk-slack: the bot token is missing ${missing.join(", ")}; add ${missing.length === 1 ? "it" : "them"} to the clerk's Slack app, reinstall it and store the new token as ${SLACK_TOKEN_ENV}`,
    };
  }
  const ok = `clerk-slack: Slack bot token ok for ${identity.team || "the workspace"}, with every scope the clerk needs`;
  // Without `files:read` every report is still filed, its files linked
  // rather than attached, so it is a warning: a refusal would stop the
  // clerk over screenshots. A KPI channel the bot cannot read is the same:
  // the report still reaches its recipients, and the gate retries the post.
  const files =
    (identity.scopes.includes(FILES_SCOPE)
      ? ""
      : `; warning: it lacks ${FILES_SCOPE}, so a report's files are linked on its ticket rather than attached until it is added`) +
    (await kpiChannelWarnings(client, kpiChannels));
  // Quiet posts nothing the team sees; only the operator's canvas and DM miss them.
  const writes = mode === "quiet" ? WRITE_SCOPES.filter((scope) => !identity.scopes.includes(scope)) : [];
  if (writes.length > 0) {
    return {
      code: 0,
      message: `${ok} in quiet mode; warning: it lacks ${writes.join(", ")}, so the operator's test canvas and KPI draft are not written (quiet posts nothing in the channel either way)${files}`,
    };
  }
  // A warning, never a refusal: a token without them still files every
  // report, and refusing it would stop the clerk over a daily summary.
  const kpi = missingKpiScopes(identity.scopes);
  if (kpi.length > 0) return { code: 0, message: `${ok}; warning: the daily KPI report (clerk.kpiReport) also needs ${kpi.join(", ")}, which the token lacks${files}` };
  return { code: 0, message: `${ok}${files}` };
}

/**
 * A warning per `clerk.kpiReport.channels` entry the bot cannot read or is
 * not a member of, as one suffix. Never a refusal: the channel post is the
 * report's least part, and a check that cannot ask (a blip) says so too.
 */
async function kpiChannelWarnings(client: SlackClient, channels: readonly string[]): Promise<string> {
  let out = "";
  for (const channel of channels) {
    try {
      if (!(await client.isChannelMember(channel))) {
        out += `; warning: the clerk's bot is not a member of KPI channel ${channel}, so the daily report is not posted there until it is invited (/invite in the channel)`;
      }
    } catch (error) {
      const why = error instanceof SlackError ? error.failure.why : (error as Error).message;
      out += `; warning: KPI channel ${channel} cannot be read (${why}); invite the clerk's bot to it, or fix 'clerk.kpiReport.channels'`;
    }
  }
  return out;
}

/**
 * The project's clerk mode, and its KPI channels, read from the worktree the
 * supervisor runs the check in, as `clerk/jira.ts --check-token` reads its
 * target. Live, the strictest, and no channels when it cannot be read: the
 * gate's own config load refuses a broken file anyway.
 */
function configured(): { mode: ClerkMode; channels: string[] } {
  try {
    const rules = clerkRules(loadProjectConfig(projectRoot()));
    return { mode: rules?.mode ?? "live", channels: rules?.kpiReport?.channels ?? [] };
  } catch {
    return { mode: "live", channels: [] };
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || argv[0] !== "--check-token") {
    console.error("usage: bun clerk/slack.ts --check-token");
    process.exitCode = 64;
  } else {
    const { mode, channels } = configured();
    const { code, message } = await checkToken(process.env, fetch, mode, channels);
    (code === 0 ? console.log : console.error)(message);
    process.exitCode = code;
  }
}
