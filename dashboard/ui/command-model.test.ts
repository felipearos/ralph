import { describe, expect, it } from "vitest";

import type { BridgeStatusView, RelayedCommandView } from "../contracts";
import { availability, COMMAND_ROUTES, commandUrl, decodeAnswer, noticeText, sendCommand, type SendDeps } from "./command-model";

const START = Date.parse("2026-11-03T10:00:00.000Z");

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake fetch answering from a queue, or from a function of the URL, and recording every call. */
function fakeNet(answers: (Response | ((url: string) => Response | Promise<Response>))[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    if (next === undefined) throw new Error("no answer queued");
    return typeof next === "function" ? next(url) : next;
  };
  return { fetch, calls };
}

/** A clock the injected sleep advances, so a relay's expiry passes without waiting. */
function fakeClock() {
  let at = START;
  return { now: () => at, sleep: async (ms: number) => void (at += ms) };
}

const deps = (fetch: SendDeps["fetch"], over: Partial<SendDeps> = {}): SendDeps => ({
  fetch,
  remote: false,
  project: "loggd",
  ...fakeClock(),
  ...over,
});

const bridge = (over: Partial<BridgeStatusView> = {}): BridgeStatusView => ({
  live: true,
  snapshots: "hot",
  lastSeenAt: "2026-11-03T09:59:57.000Z",
  wake: "realtime",
  local: "ok",
  controls: "enabled",
  why: null,
  schema: { bridge: 1, app: 1 },
  ...over,
});

const relay = (expiresAt = "2026-11-03T10:00:30.000Z") => json({ relay: { id: "c 1", state: "queued", expiresAt } }, 202);

const view = (over: Partial<RelayedCommandView>): RelayedCommandView => ({
  id: "c 1",
  kind: "control",
  state: "claimed",
  createdAt: "2026-11-03T10:00:00.000Z",
  expiresAt: "2026-11-03T10:00:30.000Z",
  finishedAt: null,
  httpStatus: null,
  result: null,
  why: null,
  ...over,
});

describe("decoding an answer", () => {
  it("answers a 2xx JSON body as the value", async () => {
    expect(await decodeAnswer(json({ applied: true }))).toEqual({ ok: true, value: { applied: true } });
  });

  it("answers a 202 or 204 with no body as null", async () => {
    expect(await decodeAnswer(new Response(null, { status: 202 }))).toEqual({ ok: true, value: null });
    expect(await decodeAnswer(new Response(null, { status: 204 }))).toEqual({ ok: true, value: null });
  });

  it("answers a 2xx body that is not JSON as Malformed", async () => {
    const answer = await decodeAnswer(new Response("<html>", { status: 200 }));
    expect(answer).toMatchObject({ ok: false, error: { kind: "Malformed", status: 200 } });
  });

  it("answers an { error, message } refusal with its kind, message and status", async () => {
    expect(await decodeAnswer(json({ error: "Halted", message: "the loop is stopping" }, 409))).toEqual({
      ok: false,
      error: { kind: "Halted", message: "the loop is stopping", status: 409 },
    });
  });

  it("keeps a refusal's string path, and adds no path key without one", async () => {
    expect(await decodeAnswer(json({ error: "CloneTargetExists", message: "exists", path: "/home/me/widget" }, 409))).toEqual({
      ok: false,
      error: { kind: "CloneTargetExists", message: "exists", status: 409, path: "/home/me/widget" },
    });
    const answer = await decodeAnswer(json({ error: "AlreadyRegistered", message: "dup", path: 3 }, 409));
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && "path" in answer.error).toBe(false);
  });

  it("keeps a refusal's problems, only the strings", async () => {
    expect(await decodeAnswer(json({ error: "Invalid", problems: ["no name", 3, "no repo"] }, 400))).toEqual({
      ok: false,
      error: { kind: "Invalid", message: "", status: 400, problems: ["no name", "no repo"] },
    });
  });

  it("answers a non-JSON error body as Malformed with the status", async () => {
    expect(await decodeAnswer(new Response("Bad Gateway", { status: 502 }))).toEqual({
      ok: false,
      error: { kind: "Malformed", message: "HTTP 502", status: 502 },
    });
  });

  it("answers a JSON error body without a string error as Malformed", async () => {
    expect(await decodeAnswer(json({ error: 7 }, 500))).toEqual({
      ok: false,
      error: { kind: "Malformed", message: "HTTP 500", status: 500 },
    });
  });
});

describe("sending a command", () => {
  it("posts JSON with same-origin credentials to the scoped URL", async () => {
    const net = fakeNet([json({ applied: true })]);
    const answer = await sendCommand("/api/control", { loop: "rafa" }, deps(net.fetch));
    expect(answer).toEqual({ ok: true, value: { applied: true } });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url).toBe("/api/p/loggd/control");
    expect(net.calls[0]!.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loop: "rafa" }),
      credentials: "same-origin",
    });
  });

  it("sends no body and no content-type when none is given", async () => {
    const net = fakeNet([new Response(null, { status: 204 })]);
    expect(await sendCommand("/api/chat/<id>", undefined, deps(net.fetch, { params: { id: "x" } }))).toEqual({ ok: true, value: null });
    expect(net.calls[0]!.init.method).toBe("DELETE");
    expect(net.calls[0]!.init.headers).toBeUndefined();
    expect(net.calls[0]!.init.body).toBeUndefined();
  });

  it("answers a fetch rejection as Network", async () => {
    const fetch = async (): Promise<Response> => {
      throw new TypeError("Failed to fetch");
    };
    expect(await sendCommand("/api/control", {}, deps(fetch))).toEqual({
      ok: false,
      error: { kind: "Network", message: "Failed to fetch", status: null },
    });
  });

  it("answers an aborted request as Aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = async (): Promise<Response> => {
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    expect(await sendCommand("/api/control", {}, deps(fetch, { signal: controller.signal }))).toMatchObject({
      ok: false,
      error: { kind: "Aborted", status: null },
    });
  });

  it("stops following a relay once the caller aborts, answering Aborted", async () => {
    const controller = new AbortController();
    const net = fakeNet([relay(), () => json(view({ state: "claimed" }))]);
    const clock = fakeClock();
    const sleep = async (ms: number) => {
      await clock.sleep(ms);
      // The caller gives up after the first read has come back still claimed.
      if (net.calls.length >= 2) controller.abort();
    };
    const answer = await sendCommand("/api/control", {}, deps(net.fetch, { remote: true, signal: controller.signal, sleep, now: clock.now }));
    expect(answer).toMatchObject({ ok: false, error: { kind: "Aborted", status: null } });
    // Abandoned at the first pause after the abort, not polled until the expiry.
    expect(net.calls.length).toBe(2);
    expect(net.calls[1]!.init.signal).toBe(controller.signal);
  });

  it("follows a relay to the machine's answer, reading the project's command once queued", async () => {
    const queued: string[] = [];
    const net = fakeNet([relay(), json(view({ state: "claimed" })), json(view({ state: "done", httpStatus: 200, result: { applied: true } }))]);
    const answer = await sendCommand("/api/control", { loop: "rafa" }, deps(net.fetch, { remote: true, onQueued: (r) => queued.push(r.id) }));
    expect(answer).toEqual({ ok: true, value: { applied: true } });
    expect(queued).toEqual(["c 1"]);
    expect(net.calls.slice(1).map((call) => call.url)).toEqual(["/api/p/loggd/commands/c%201", "/api/p/loggd/commands/c%201"]);
    expect(net.calls[1]!.init.cache).toBe("no-store");
  });

  it("follows a relay to the machine's refusal", async () => {
    let queued = 0;
    const net = fakeNet([relay(), json(view({ state: "refused", httpStatus: 409, result: { error: "Halted", message: "stopping" } }))]);
    const answer = await sendCommand("/api/control", {}, deps(net.fetch, { remote: true, onQueued: () => queued++ }));
    expect(answer).toEqual({ ok: false, error: { kind: "Halted", message: "stopping", status: 409 } });
    expect(queued).toBe(1);
  });

  it("answers NoAnswer when the relayed command never ends", async () => {
    const net = fakeNet([relay(), () => json(view({ state: "claimed" }))]);
    const answer = await sendCommand("/api/control", {}, deps(net.fetch, { remote: true }));
    expect(answer).toMatchObject({ ok: false, error: { kind: "NoAnswer", status: 504 } });
  });

  it.each([
    ["expired", "Expired"],
    ["refused", "Refused"],
    ["failed", "Failed"],
  ] as const)("answers a relayed command that ended %s without an answer as %s", async (state, kind) => {
    const net = fakeNet([relay(), json(view({ state, why: "no machine" }))]);
    expect(await sendCommand("/api/control", {}, deps(net.fetch, { remote: true }))).toEqual({
      ok: false,
      error: { kind, message: "no machine", status: 503 },
    });
  });

  it("answers a relay on a route that is not relayed as Malformed", async () => {
    const net = fakeNet([relay()]);
    expect(await sendCommand("/api/lineup/save", {}, deps(net.fetch))).toMatchObject({
      ok: false,
      error: { kind: "Malformed", status: 202 },
    });
    expect(net.calls).toHaveLength(1);
  });

  it("refuses a local-only route on the remote page without fetching", async () => {
    const net = fakeNet([json({})]);
    expect(await sendCommand("/api/lineup/save", {}, deps(net.fetch, { remote: true }))).toEqual({
      ok: false,
      error: { kind: "LocalOnly", message: "Local dashboard only", status: null },
    });
    expect(net.calls).toHaveLength(0);
  });
});

describe("availability", () => {
  it("offers every route locally", () => {
    for (const path of Object.keys(COMMAND_ROUTES) as (keyof typeof COMMAND_ROUTES)[]) {
      expect(availability(path, { remote: false, bridge: null })).toEqual({ disabled: false, why: null });
    }
  });

  it("disables a local-only route remotely", () => {
    expect(availability("/api/lineup/save", { remote: true, bridge: bridge() })).toEqual({ disabled: true, why: "Local dashboard only" });
  });

  it("disables a relayed route while the bridge disallows controls", () => {
    expect(availability("/api/control", { remote: true, bridge: bridge({ controls: "disabled", why: "kill switch" }) })).toEqual({
      disabled: true,
      why: "kill switch",
    });
  });

  it("offers a relayed route while the bridge allows controls", () => {
    expect(availability("/api/control", { remote: true, bridge: bridge() })).toEqual({ disabled: false, why: null });
  });

  it("offers an open route remotely", () => {
    expect(availability("/api/intake/login", { remote: true, bridge: null })).toEqual({ disabled: false, why: null });
  });
});

describe("the route table", () => {
  it("keeps chat, verifier, sentinel, rerun setup, project settings, the worktrees folder and worktree cleanup, which the remote function never serves, local-only", () => {
    expect(COMMAND_ROUTES["/api/chat/<id>"].remote).toBe("local-only");
    expect(COMMAND_ROUTES["/api/chat"].remote).toBe("local-only");
    expect(COMMAND_ROUTES["/api/agents/verifier"].remote).toBe("local-only");
    expect(COMMAND_ROUTES["/api/agents/sentinel"].remote).toBe("local-only");
    expect(COMMAND_ROUTES["/api/agents/setup"].remote).toBe("local-only");
    expect(availability("/api/agents/setup", { remote: true, bridge: bridge() })).toEqual({ disabled: true, why: "Local dashboard only" });
    expect(COMMAND_ROUTES["/api/settings/project"].remote).toBe("local-only");
    expect(availability("/api/settings/project", { remote: true, bridge: bridge() })).toEqual({ disabled: true, why: "Local dashboard only" });
    expect(COMMAND_ROUTES["/api/settings/gates/run"].remote).toBe("local-only");
    expect(availability("/api/settings/gates/run", { remote: true, bridge: bridge() })).toEqual({ disabled: true, why: "Local dashboard only" });
    expect(COMMAND_ROUTES["/api/settings/worktrees"].remote).toBe("local-only");
    expect(availability("/api/settings/worktrees", { remote: true, bridge: bridge() })).toEqual({ disabled: true, why: "Local dashboard only" });
    expect(COMMAND_ROUTES["/api/settings/worktrees/cleanup"].remote).toBe("local-only");
    expect(availability("/api/settings/worktrees/cleanup", { remote: true, bridge: bridge() })).toEqual({ disabled: true, why: "Local dashboard only" });
    expect(COMMAND_ROUTES["/api/intake/logout"].remote).toBe("open");
  });

  it("addresses the project-list routes at the top level, even with a project", () => {
    for (const path of ["/api/projects", "/api/projects/remove", "/api/projects/pick-folder"] as const) {
      expect(COMMAND_ROUTES[path].scope).toBe("root");
      expect(commandUrl(path, { project: "loggd" })).toBe(path);
    }
  });

  it("scopes a project route to its project", () => {
    expect(COMMAND_ROUTES["/api/control"].scope).toBe("project");
    expect(commandUrl("/api/control", { project: "loggd" })).toBe("/api/p/loggd/control");
    expect(commandUrl("/api/control", { project: null })).toBe("/api/control");
  });

  it("fills and encodes the id", () => {
    expect(commandUrl("/api/chat/<id>/turn", { project: "loggd", params: { id: "a b" } })).toBe("/api/p/loggd/chat/a%20b/turn");
  });
});

describe("notice text", () => {
  it("names the kind, and the message when there is one", () => {
    expect(noticeText({ kind: "Halted", message: "stopping", status: 409 })).toBe("Halted: stopping");
    expect(noticeText({ kind: "Malformed", message: "", status: 500 })).toBe("Malformed");
  });
});
