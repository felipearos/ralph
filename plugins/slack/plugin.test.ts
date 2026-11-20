import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_TEMPLATE, notify, prNumberOf, readSettings, render, settingsPath } from "./plugin";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project root (no `.ralph/config.json`, so a GitHub tracker) and a settings directory. */
function setup(settings: object | null) {
  const dir = mkdtempSync(join(tmpdir(), "slack-plugin-"));
  scratch.push(dir);
  const root = join(dir, "project");
  const config = join(dir, "slack");
  mkdirSync(root);
  mkdirSync(config);
  const env = { RALPH_SLACK_CONFIG_DIR: config, RALPH_PROJECT_ID: "acme-pwa", RALPH_LOOP_NAME: "ralph" };
  if (settings !== null) writeFileSync(settingsPath("acme-pwa", env), JSON.stringify(settings));
  return { root, env };
}

/** A fake Slack: records every post and answers `answer`. */
function slack(answer: object = { ok: true }) {
  const posts: { auth: string | null; body: Record<string, unknown> }[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    posts.push({ auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof fetch;
  return { posts, fetcher };
}

// No `/pull/<n>` in the link, so the plugin never shells out to `gh` for a title.
const ALERT = { kind: "pr-opened", subject: "PR opened for #32", body: "https://example.test/pr", ticket: 32 };

describe("the Slack plugin", () => {
  it("posts a pr-opened alert to the configured channel with the bot token", async () => {
    const { root, env } = setup({ token: "xoxb-test", channel: "C0PWA", template: "{loop}: {url} ({ticket}) {title}" });
    const { posts, fetcher } = slack();
    expect(await notify(root, ALERT, env, fetcher)).toEqual({ ok: true });
    expect(posts).toEqual([
      {
        auth: "Bearer xoxb-test",
        body: { channel: "C0PWA", text: "Ralph: https://example.test/pr (#32) PR opened for #32", unfurl_links: false },
      },
    ]);
  });

  it("posts nothing for a kind the settings do not name, and answers ok", async () => {
    const { root, env } = setup({ token: "xoxb-test", channel: "C0PWA" });
    const { posts, fetcher } = slack();
    expect(await notify(root, { ...ALERT, kind: "gate-failure" }, env, fetcher)).toEqual({ ok: true });
    expect(posts).toEqual([]);
  });

  it("answers not ok, without posting, when the host has no settings", async () => {
    const { root, env } = setup(null);
    const { posts, fetcher } = slack();
    const answer = await notify(root, ALERT, env, fetcher);
    expect(answer.ok).toBe(false);
    expect(answer.why).toContain("no Slack settings at");
    expect(posts).toEqual([]);
  });

  it("names Slack's refusal, so the plugin health says the bot is not in the channel", async () => {
    const { root, env } = setup({ token: "xoxb-test", channel: "C0PWA" });
    const { fetcher } = slack({ ok: false, error: "not_in_channel" });
    expect(await notify(root, ALERT, env, fetcher)).toEqual({ ok: false, why: "Slack refused the post: not_in_channel" });
  });

  it("refuses settings without a token or a channel, and defaults the kinds and the template", () => {
    const { env } = setup(null);
    const path = settingsPath("acme-pwa", env);
    writeFileSync(path, JSON.stringify({ channel: "C0PWA" }));
    expect(readSettings(path)).toContain("has no 'token'");
    writeFileSync(path, JSON.stringify({ token: "xoxb-test" }));
    expect(readSettings(path)).toContain("has no 'channel'");
    writeFileSync(path, JSON.stringify({ token: "xoxb-test", channel: "C0PWA" }));
    expect(readSettings(path)).toEqual({ token: "xoxb-test", channel: "C0PWA", kinds: ["pr-opened"], template: DEFAULT_TEMPLATE });
  });

  it("reads the PR number out of its link and fills only the placeholders it knows", () => {
    expect(prNumberOf("https://github.com/example-org/acme-pwa/pull/41")).toBe("41");
    expect(prNumberOf("https://example.test/pr")).toBeNull();
    expect(render(DEFAULT_TEMPLATE, { loop: "Ralph", url: "https://x/pull/41", pr: "41", ticket: "OAI-32", title: "Pull to refresh" })).toBe(
      "Ralph opened <https://x/pull/41|PR #41> for OAI-32: Pull to refresh",
    );
    expect(render("{other} {pr}", { pr: "41" })).toBe("{other} 41");
  });
});
