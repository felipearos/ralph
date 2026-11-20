#!/usr/bin/env bun
/**
 * The Slack plugin: a loop's alerts posted to a channel the team reads.
 *
 * Run by the plugin host (`ralph/plugins.ts`) as `plugin.ts <hook>` with the
 * payload on stdin, and answers with one JSON line. Only `notify` does
 * anything: an alert of a kind the settings name — `pr-opened` unless they say
 * otherwise — becomes one message in the channel. `push-notification.ts`
 * records each occurrence once, so a PR is announced once however many
 * sessions touch it. `on-event` and `inbox` answer ok and do nothing.
 *
 * Built for a team that reviews and merges what a loop writes (`merge:
 * "human"`, a client app's loops 2026-10-26): the PR link lands where they already work,
 * instead of in a GitHub notification nobody reads.
 *
 * Off unless a project lists `slack` in `.ralph/config.json`'s `plugins`. Its
 * settings are on the host, never in `.ralph/`, because they hold a bot token:
 * `~/.config/ralph/slack/<project id>.json` —
 *
 *   {
 *     "token": "xoxb-…",          a bot token with chat:write, in the channel
 *     "channel": "C0…",           the channel id, not its name
 *     "kinds": ["pr-opened"],     optional; the alert kinds to post
 *     "template": "…"             optional; {loop} {pr} {url} {title} {ticket}
 *   }
 *
 * `plugin.ts status` prints the plugin's own panel line, for `status.sh`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { currentProjectId } from "../../project-id";
import { projectRoot } from "../../paths";
import { keyedProjectTracker } from "../../tracker/project";

interface Answer {
  ok: boolean;
  why?: string;
}

interface Settings {
  token: string;
  channel: string;
  kinds: string[];
  template: string;
}

export const DEFAULT_TEMPLATE = "{loop} opened <{url}|PR #{pr}> for {ticket}: {title}";
const POST_TIMEOUT_MS = 15_000;

/** Where this project's settings live; `RALPH_SLACK_CONFIG_DIR` moves the directory, for tests. */
export function settingsPath(projectId: string, env: Record<string, string | undefined> = process.env): string {
  return join(env.RALPH_SLACK_CONFIG_DIR ?? join(homedir(), ".config", "ralph", "slack"), `${projectId}.json`);
}

/** The settings, or why there are none. A missing file is a plugin that cannot post, said once per alert. */
export function readSettings(path: string): Settings | string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return `no Slack settings at ${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
  const spelt = (raw ?? {}) as Record<string, unknown>;
  if (typeof spelt.token !== "string" || spelt.token.trim() === "") return `${path} has no 'token'`;
  if (typeof spelt.channel !== "string" || spelt.channel.trim() === "") return `${path} has no 'channel'`;
  const kinds = Array.isArray(spelt.kinds) && spelt.kinds.every((kind) => typeof kind === "string") ? (spelt.kinds as string[]) : ["pr-opened"];
  const template = typeof spelt.template === "string" && spelt.template.trim() !== "" ? spelt.template : DEFAULT_TEMPLATE;
  return { token: spelt.token.trim(), channel: spelt.channel.trim(), kinds, template };
}

/** The PR number out of a PR link: `push-notification.ts`'s `pr-opened` body is the link. */
export function prNumberOf(url: string): string | null {
  return /\/pull\/(\d+)\b/.exec(url)?.[1] ?? null;
}

export function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{(loop|pr|url|title|ticket)\}/g, (_, name: string) => values[name] ?? "");
}

/**
 * The PR's title, for a message a person can act on without opening it. A
 * read that fails leaves it out: the link is what matters, and a plugin that
 * held an alert for a title would be failing the loop's one job for it.
 */
function prTitle(url: string): string {
  const read = spawnSync("gh", ["pr", "view", url, "--json", "title", "--jq", ".title"], { encoding: "utf8", timeout: 15_000 });
  return read.status === 0 ? read.stdout.trim() : "";
}

/** `OAI-32` on Jira, `AND-184` on Linear, `#184` on GitHub. */
function ticketRef(root: string, ticket: unknown): string {
  const number = typeof ticket === "number" ? ticket : Number(ticket);
  if (!Number.isInteger(number) || number <= 0) return "";
  try {
    return keyedProjectTracker(root)?.ref(number) ?? `#${number}`;
  } catch {
    return `#${number}`;
  }
}

export async function post(settings: Settings, text: string, fetcher: typeof fetch = fetch): Promise<Answer> {
  try {
    const response = await fetcher("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: settings.channel, text, unfurl_links: false }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    const json = (await response.json()) as { ok?: boolean; error?: string };
    // `not_in_channel` is the one an operator hits first: the bot must be invited.
    return json.ok === true ? { ok: true } : { ok: false, why: `Slack refused the post: ${json.error ?? `HTTP ${response.status}`}` };
  } catch (error) {
    return { ok: false, why: `Slack could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function notify(root: string, alert: Record<string, unknown>, env = process.env, fetcher: typeof fetch = fetch): Promise<Answer> {
  const settings = readSettings(settingsPath(currentProjectId(root, env), env));
  if (typeof settings === "string") return { ok: false, why: settings };
  const kind = String(alert.kind ?? "");
  if (!settings.kinds.includes(kind)) return { ok: true };
  const url = String(alert.body ?? "").trim();
  const pr = prNumberOf(url) ?? "";
  const loop = env.RALPH_LOOP_NAME ?? "ralph";
  const text = render(settings.template, {
    loop: `${loop[0]!.toUpperCase()}${loop.slice(1)}`,
    pr,
    url,
    title: pr === "" ? String(alert.subject ?? "") : prTitle(url),
    ticket: ticketRef(root, alert.ticket),
  });
  return post(settings, text, fetcher);
}

async function main(): Promise<Answer | null> {
  const root = process.env.RALPH_STATE_ROOT ?? projectRoot();
  const hook = process.argv[2];
  if (hook === "status") {
    const settings = readSettings(settingsPath(currentProjectId(root, process.env)));
    console.log(typeof settings === "string" ? `slack: ${settings}` : `slack: posting ${settings.kinds.join(", ")} to ${settings.channel}`);
    return null;
  }
  const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
  switch (hook) {
    case "on-event":
    case "inbox":
      return { ok: true };
    case "notify":
      return notify(root, (input.alert ?? {}) as Record<string, unknown>);
    default:
      return { ok: false, why: `unknown hook '${String(hook)}'` };
  }
}

if (import.meta.main) {
  let result: Answer | null;
  try {
    result = await main();
  } catch (error) {
    result = { ok: false, why: error instanceof Error ? error.message : String(error) };
  }
  if (result !== null) console.log(JSON.stringify(result));
}
