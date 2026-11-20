// @vitest-environment node
/**
 * The clerk's Slack client against a fake Slack at the HTTP seam
 * (felipearos/ralph#317): what each failure is classified as, and the token
 * check the supervisor runs before handing the token to the gate. No network.
 */
import { describe, expect, it } from "vitest";

import { BOT, fakeSlack, type FakeFailure } from "./fakes";
import { FILES_SCOPE, KPI_SCOPES, REQUIRED_SCOPES, SlackError, WRITE_SCOPES, checkToken, type Fetch, compareTs, missingScopes, msTs, retryAfterSeconds, slackClient, tsMs } from "./slack";

const CHANNEL = "C0TESTCHAN1";
const TOKEN_ENV = { RALPH_CLERK_SLACK_TOKEN: "xoxb-fake" };

const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SlackError) return error.failure;
    throw error;
  }
  throw new Error("expected a SlackError");
};

describe("the token check the supervisor runs", () => {
  it("passes a token that authenticates and carries every scope the clerk needs", async () => {
    const slack = fakeSlack(CHANNEL);
    const result = await checkToken(TOKEN_ENV, slack.fetch);
    expect(result).toEqual({ code: 0, message: "clerk-slack: Slack bot token ok for Example, with every scope the clerk needs" });
    expect(slack.calls.map((call) => call.method)).toEqual(["auth.test"]);
  });

  it("warns, without refusing, about a token missing the KPI report's scopes (#453)", async () => {
    const slack = fakeSlack(CHANNEL, { scopes: [...REQUIRED_SCOPES, FILES_SCOPE] });
    expect(await checkToken(TOKEN_ENV, slack.fetch)).toEqual({
      code: 0,
      message:
        "clerk-slack: Slack bot token ok for Example, with every scope the clerk needs; warning: the daily KPI report (clerk.kpiReport) also needs im:write, groups:read, which the token lacks",
    });
  });

  it("warns, without refusing, about a token missing files:read: the files are linked until it is added", async () => {
    const slack = fakeSlack(CHANNEL, { scopes: [...REQUIRED_SCOPES, ...KPI_SCOPES] });
    expect(await checkToken(TOKEN_ENV, slack.fetch)).toEqual({
      code: 0,
      message:
        "clerk-slack: Slack bot token ok for Example, with every scope the clerk needs; warning: it lacks files:read, so a report's files are linked on its ticket rather than attached until it is added",
    });
    expect((await checkToken(TOKEN_ENV, slack.fetch, "quiet")).code).toBe(0);
  });

  it("refuses a missing token without asking Slack anything", async () => {
    const slack = fakeSlack(CHANNEL);
    expect(await checkToken({}, slack.fetch)).toEqual({ code: 1, message: "clerk-slack: no RALPH_CLERK_SLACK_TOKEN in the environment" });
    expect(slack.calls).toEqual([]);
  });

  it("refuses an invalid token, with the remedy", async () => {
    const slack = fakeSlack(CHANNEL);
    slack.fail("auth.test", { error: "invalid_auth" });
    const result = await checkToken(TOKEN_ENV, slack.fetch);
    expect(result.code).toBe(1);
    expect(result.message).toContain("invalid_auth");
    expect(result.message).toContain("store a valid bot token (xoxb-…) as RALPH_CLERK_SLACK_TOKEN");
  });

  it("refuses a token missing any one required scope, naming it", async () => {
    for (const scope of REQUIRED_SCOPES) {
      const slack = fakeSlack(CHANNEL, { scopes: REQUIRED_SCOPES.filter((other) => other !== scope) });
      const result = await checkToken(TOKEN_ENV, slack.fetch);
      expect(result.code, scope).toBe(1);
      expect(result.message).toContain(`missing ${scope}`);
    }
    // A superset is fine: a bot made for something else as well is still able
    // to do the clerk's work, and the narrowness that matters is the gate's.
    const wide = fakeSlack(CHANNEL, { scopes: [...REQUIRED_SCOPES, "files:read"] });
    expect((await checkToken(TOKEN_ENV, wide.fetch)).code).toBe(0);
  });

  it("in quiet mode, needs only the read scopes: the write ones are a warning, never a refusal (#443)", async () => {
    const reads = REQUIRED_SCOPES.filter((scope) => !(WRITE_SCOPES as readonly string[]).includes(scope));
    expect(missingScopes(reads, "quiet")).toEqual([]);
    expect(missingScopes(reads, "live")).toEqual([...WRITE_SCOPES]);
    const slack = fakeSlack(CHANNEL, { scopes: [...reads, FILES_SCOPE] });
    expect(await checkToken(TOKEN_ENV, slack.fetch, "quiet")).toEqual({
      code: 0,
      message:
        "clerk-slack: Slack bot token ok for Example, with every scope the clerk needs in quiet mode; warning: it lacks canvases:write, chat:write, so the operator's test canvas and KPI draft are not written (quiet posts nothing in the channel either way)",
    });
    // Live and shadow still refuse it.
    expect((await checkToken(TOKEN_ENV, slack.fetch, "live")).code).toBe(1);
    expect((await checkToken(TOKEN_ENV, slack.fetch, "shadow")).code).toBe(1);
    // A read scope is still required in quiet.
    const blind = fakeSlack(CHANNEL, { scopes: REQUIRED_SCOPES.filter((scope) => scope !== "channels:history") });
    expect((await checkToken(TOKEN_ENV, blind.fetch, "quiet")).message).toContain("missing channels:history");
  });

  it("warns, without refusing, about a KPI channel the bot cannot read", async () => {
    const slack = fakeSlack(CHANNEL, { joined: ["C0KPICHAN01"] });
    expect(await checkToken(TOKEN_ENV, slack.fetch, "live", ["C0KPICHAN01"])).toEqual({
      code: 0,
      message: "clerk-slack: Slack bot token ok for Example, with every scope the clerk needs",
    });
    const result = await checkToken(TOKEN_ENV, slack.fetch, "live", ["C0KPICHAN01", "G0PRIVATE01"]);
    expect(result).toEqual({
      code: 0,
      message:
        "clerk-slack: Slack bot token ok for Example, with every scope the clerk needs; warning: KPI channel G0PRIVATE01 cannot be read (Slack conversations.info refused the clerk: channel_not_found); invite the clerk's bot to it, or fix 'clerk.kpiReport.channels'",
    });
    // A channel Slack says the bot is not in is a warning too.
    const outside = fakeSlack(CHANNEL);
    const isMember: Fetch = async (url, init) =>
      url.includes("conversations.info") ? new Response(JSON.stringify({ ok: true, channel: { id: "C0KPICHAN01", is_member: false } })) : outside.fetch(url, init);
    expect((await checkToken(TOKEN_ENV, isMember, "live", ["C0KPICHAN01"])).message).toContain("is not a member of KPI channel C0KPICHAN01");
  });

  it("lets a token through when Slack cannot be asked, so a blip at start does not stop the loop", async () => {
    // A withheld token is a preflight DENIAL for the clerk, so exiting non-zero
    // here would turn a timeout at 3 a.m. into a stopped loop. The gate asks
    // `auth.test` on every poll, and a real refusal there stops it properly.
    for (const failure of [{ network: "getaddrinfo ENOTFOUND slack.com" }, { status: 503 as const }, { status: 429 as const, retryAfter: "5" }]) {
      const slack = fakeSlack(CHANNEL);
      slack.fail("auth.test", failure);
      const result = await checkToken(TOKEN_ENV, slack.fetch);
      expect(result.code, JSON.stringify(failure)).toBe(0);
      expect(result.message).toContain("could not be reached to prove the token");
    }
  });

  it("never prints the token", async () => {
    const slack = fakeSlack(CHANNEL);
    slack.fail("auth.test", { error: "invalid_auth" });
    const result = await checkToken({ RALPH_CLERK_SLACK_TOKEN: "xoxb-very-secret-value" }, slack.fetch);
    expect(result.message).not.toContain("xoxb-very-secret-value");
  });
});

describe("what a failure is", () => {
  const client = (slack: ReturnType<typeof fakeSlack>) => slackClient("xoxb-fake", slack.fetch, CHANNEL);

  it("is rate-limited on a 429, for exactly what Retry-After says", async () => {
    const slack = fakeSlack(CHANNEL);
    slack.fail("conversations.history", { status: 429, retryAfter: "42" });
    expect(await failureOf(client(slack).history(CHANNEL, "0"))).toEqual({
      kind: "rate-limited",
      why: "Slack conversations.history is rate limited for 42s",
      retryAfterSeconds: 42,
    });
    expect(retryAfterSeconds(null)).toBe(60);
    expect(retryAfterSeconds("nonsense")).toBe(60);
    expect(retryAfterSeconds("1.2")).toBe(2);
  });

  it("is transient on a 5xx, a network error or an unknown error code", async () => {
    for (const failure of [{ status: 500 as const }, { network: "socket hang up" }, { error: "internal_error" }, { error: "something_new" }]) {
      const slack = fakeSlack(CHANNEL);
      slack.fail("conversations.history", failure);
      expect((await failureOf(client(slack).history(CHANNEL, "0"))).kind, JSON.stringify(failure)).toBe("transient");
    }
  });

  it("is a denial, with a remedy, for each code no wait can fix", async () => {
    const cases: [string, string][] = [
      ["invalid_auth", "store a valid bot token"],
      ["token_revoked", "reinstall the clerk's Slack app"],
      ["missing_scope", "add the channels:history scope"],
      ["not_in_channel", `invite the clerk's bot to ${CHANNEL}`],
      ["channel_not_found", "check 'clerk.channel'"],
    ];
    for (const [code, remedy] of cases) {
      const slack = fakeSlack(CHANNEL);
      slack.fail("conversations.history", { error: code, ...(code === "missing_scope" ? { needed: "channels:history" } : {}) });
      const failure = await failureOf(client(slack).history(CHANNEL, "0"));
      expect(failure.kind, code).toBe("denied");
      expect(failure.kind === "denied" && failure.code).toBe(code);
      expect(failure.kind === "denied" && failure.remedy).toContain(remedy);
    }
  });
});

describe("reading the channel", () => {
  it("fails a read too long to finish in one poll rather than drop its oldest messages", async () => {
    // History pages newest-first, so a read cut short would lose exactly the
    // messages the cursor is about to pass.
    const endless: Fetch = async () =>
      new Response(JSON.stringify({ ok: true, messages: [{ ts: "1.000100", user: "U1" }], has_more: true, response_metadata: { next_cursor: "more" } }), { status: 200 });
    expect((await failureOf(slackClient("xoxb-fake", endless).history(CHANNEL, "0"))).kind).toBe("transient");
  });

  it("reads history oldest first and a thread parent first, every page", async () => {
    const slack = fakeSlack(CHANNEL);
    slack.post({ ts: "1000.000100", user: "U1", text: "uno" });
    slack.post({ ts: "1002.000100", user: "U2", text: "dos" });
    slack.post({ ts: "1001.000100", user: "U1", text: "respuesta", thread_ts: "1000.000100" });
    const client = slackClient("xoxb-fake", slack.fetch);
    expect((await client.history(CHANNEL, "999.000000")).map((message) => message.text)).toEqual(["uno", "dos"]);
    expect((await client.replies(CHANNEL, "1000.000100")).map((message) => message.text)).toEqual(["uno", "respuesta"]);
    const identity = await client.authTest();
    expect(identity).toMatchObject({ userId: BOT.userId, botId: BOT.botId, url: "https://example.slack.com/" });
    expect(missingScopes(identity.scopes)).toEqual([]);
  });

  it("orders timestamps exactly, and converts them both ways", () => {
    expect(compareTs("1000.000100", "1000.000099")).toBeGreaterThan(0);
    expect(compareTs("999.999999", "1000.000000")).toBeLessThan(0);
    expect(compareTs("1000.1", "1000.100000")).toBe(0);
    expect(tsMs("1760961600.123456")).toBe(1760961600123);
    expect(msTs(1760961600123)).toBe("1760961600.123000");
  });
});

describe("writing a canvas (felipearos/ralph#319)", () => {
  it("replaces the whole document with one POST of JSON, and creates a canvas the same way", async () => {
    const slack = fakeSlack(CHANNEL, { canvases: ["F0SHADOWCV1"] });
    const client = slackClient("xoxb-fake", slack.fetch);
    expect(await client.replaceCanvas("F0SHADOWCV1", "# Hola\n")).toBe("replaced");
    expect(slack.canvases.get("F0SHADOWCV1")).toBe("# Hola\n");
    expect(slack.calls.at(-1)!.body).toEqual({
      canvas_id: "F0SHADOWCV1",
      // No section_id: the replace covers the whole document.
      changes: [{ operation: "replace", document_content: { type: "markdown", markdown: "# Hola\n" } }],
    });
    const id = await client.createCanvas("Prueba", "# Nuevo\n");
    expect(slack.calls.at(-1)!.body).toEqual({ title: "Prueba", document_content: { type: "markdown", markdown: "# Nuevo\n" } });
    expect(slack.canvases.get(id)).toBe("# Nuevo\n");
  });

  it("sends the token as a bearer header and the body as JSON", async () => {
    const seen: RequestInit[] = [];
    const recording: Fetch = async (_url, init) => {
      seen.push(init);
      return new Response(JSON.stringify({ ok: true, canvas_id: "F0NEW00001" }), { status: 200 });
    };
    await slackClient("xoxb-fake", recording).createCanvas("Prueba", "x");
    expect(seen[0]).toMatchObject({ method: "POST", headers: { authorization: "Bearer xoxb-fake", "content-type": "application/json; charset=utf-8" } });
  });

  it("answers gone, not a failure, for a canvas that was deleted or that the bot cannot reach", async () => {
    for (const code of ["canvas_not_found", "canvas_deleted", "access_denied", "not_found"]) {
      const slack = fakeSlack(CHANNEL, { canvases: ["F0SHADOWCV1"] });
      slack.canvasGone("F0SHADOWCV1", code);
      expect(await slackClient("xoxb-fake", slack.fetch).replaceCanvas("F0SHADOWCV1", "x"), code).toBe("gone");
    }
  });

  it("classifies every other canvas failure like a read: transient, rate limited, or a denial", async () => {
    const cases: [FakeFailure, string][] = [
      [{ status: 503 }, "transient"],
      [{ error: "canvas_editing_failed" }, "transient"],
      [{ status: 429, retryAfter: "7" }, "rate-limited"],
      [{ error: "invalid_auth" }, "denied"],
      [{ error: "missing_scope", needed: "canvases:write" }, "denied"],
    ];
    for (const [failure, kind] of cases) {
      const slack = fakeSlack(CHANNEL, { canvases: ["F0SHADOWCV1"] });
      slack.fail("canvases.edit", failure);
      slack.fail("canvases.create", failure);
      const client = slackClient("xoxb-fake", slack.fetch);
      expect((await failureOf(client.replaceCanvas("F0SHADOWCV1", "x"))).kind, JSON.stringify(failure)).toBe(kind);
      expect((await failureOf(client.createCanvas("Prueba", "x"))).kind, JSON.stringify(failure)).toBe(kind);
    }
  });

  it("fails a create that answers no canvas id rather than store an empty one", async () => {
    const empty: Fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    expect((await failureOf(slackClient("xoxb-fake", empty).createCanvas("Prueba", "x"))).kind).toBe("transient");
  });
});
