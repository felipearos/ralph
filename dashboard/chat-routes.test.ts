// @vitest-environment node
/**
 * The chat routes, driven in-process through the real handler.
 *
 * `claude` is a script on disk and the redactor is `cat`, so the routes are
 * exercised over a real `ChatSessions` with real child processes: a route test
 * that stubbed the registry would prove only that the paths spell correctly.
 * Two projects are registered, because "reject an unknown project" is a claim
 * about the scoped handler, not about this module.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ChatSessions, type ChatEvent } from "./chat";
import { CHAT_PATH, evidenceOf } from "./chat-routes";
import { coderRoster, type Dashboard, type JournalEntryView, type RuntimeSnapshot, type StuckReason } from "./contracts";
import { createHandler } from "./server";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("runs chat routes over real child processes");

const scratch: string[] = [];
const sessions: ChatSessions[] = [];

afterEach(() => {
  sessions.splice(0).forEach((chats) => chats.stopAll());
  scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), "ralph-chat-route-"));
  scratch.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  writeFileSync(join(root, ".ralph", "logs", "iter-20261007T105001.log"), "rendered\n");
  writeFileSync(
    join(root, ".ralph", "logs", "supervisor-run.log"),
    "Ralph: models — orchestrator claude-opus-5 on claude\n=== Ralph iteration 7/50 (20261007T105001) session the-session ===\n",
  );
  return root;
}

function runtimeFor(root: string): RuntimeSnapshot {
  return {
    roster: coderRoster("ralph", "rafa"),
    loops: [
      {
        worktree: root,
        identity: "ralph",
        loopStatus: "failed",
        worktreeStatus: "live",
        branch: "ralph/252",
        state: {
          version: 1,
          run: "ralph-run-1",
          owner: { loop: "ralph", pid: null, host: "test" },
          worktree: root,
          branch: "ralph/252",
          stage: "iteration",
          iteration: { index: 7, max: 50 },
          heartbeat: "2026-10-07T13:00:00.000Z",
          lastEvent: null,
          stopReason: { kind: "failed", why: "iteration 7 ended without a sigil; see .ralph/logs/iter-20261007T105001.log", at: "2026-10-07T13:00:00.000Z" },
        },
        stateProblem: null,
        supervisor: "dead",
        presence: null,
      },
    ],
    reconciliation: { orphaned: [], prunable: [] },
  };
}

function handlerFor(root: string): (request: Request) => Promise<Response> {
  const bin = join(root, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash\ncat > /dev/null\nprintf '{"type":"system","subtype":"init","session_id":"forked"}\\n'\nprintf '{"type":"assistant","text":"because the baseline PNG is unreadable"}\\n'\n`,
  );
  chmodSync(bin, 0o755);
  const chats = new ChatSessions({
    claude: (args, cwd) => spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] }),
    redactor: () => spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] }),
  });
  sessions.push(chats);
  return createHandler({
    adapter: { read: async () => runtimeFor(root) },
    shell: "<html></html>",
    clock: () => ({ nowMs: Date.parse("2026-10-07T13:00:00.000Z") }),
    chats,
  });
}

const call = async <T,>(
  handler: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> => {
  const response = await handler(
    new Request(`http://127.0.0.1${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
  );
  const text = await response.text();
  // A 405 answers in plain words, as every other route here does; a helper
  // that insisted on JSON would fail the test for the wrong reason.
  try {
    return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as T };
  } catch {
    return { status: response.status, body: text as T };
  }
};

describe("starting a chat", () => {
  it("resolves the halting session and streams the answer back", async () => {
    const root = worktree();
    const handler = handlerFor(root);

    const started = await call<{ id: string; session: string; source: string }>(handler, "POST", CHAT_PATH, { loop: "ralph" });
    expect(started.status).toBe(201);
    expect(started.body.session).toBe("the-session");

    const turn = await call(handler, "POST", `${CHAT_PATH}/${started.body.id}/turn`, { text: "why are you blocked?" });
    expect(turn.status).toBe(202);

    // The long poll returns as soon as there is something, so this is not a sleep.
    let after = 0;
    let events: ChatEvent[] = [];
    for (let round = 0; round < 10; round += 1) {
      const page = await call<{ events: ChatEvent[]; next: number; status: string }>(
        handler,
        "GET",
        `${CHAT_PATH}/${started.body.id}/events?after=${after}`,
      );
      after = page.body.next;
      events = [...events, ...page.body.events];
      if (page.body.status !== "running") break;
    }
    expect(events.map((event) => event.kind)).toEqual(["operator", "seed", "agent", "agent", "turn-end"]);
    expect(events[1]!.text).toContain("operator-chat");
    expect(events[3]!.text).toContain("baseline PNG");

    const view = await call<{ events: ChatEvent[]; transcript: string }>(handler, "GET", `${CHAT_PATH}/${started.body.id}`);
    expect(view.status).toBe(200);
    expect(view.body.events).toHaveLength(5);
    expect(view.body.transcript).toContain(`chat-${started.body.id}.jsonl`);
  });

  it("takes a ticket, and says when nothing names a block of it", async () => {
    const handler = handlerFor(worktree());
    const started = await call<{ session: string | null; why: string }>(handler, "POST", CHAT_PATH, {
      loop: "ralph",
      ticket: 2013,
    });
    expect(started.status).toBe(201);
    expect(started.body.session).toBeNull();
    expect(started.body.why).toContain("#2013");
  });
});

describe("the chat routes refuse what they do not know", () => {
  it("rejects an unknown project before the chat is reached", async () => {
    const response = await call<{ error: string }>(handlerFor(worktree()), "POST", "/api/p/nope/chat", { loop: "ralph" });
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("UnknownProject");
  });

  it("rejects an unknown loop", async () => {
    const response = await call<{ error: string }>(handlerFor(worktree()), "POST", CHAT_PATH, { loop: "nobody" });
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("UnknownLoop");
  });

  it("rejects an unknown chat id on every path that takes one", async () => {
    const handler = handlerFor(worktree());
    for (const [method, path, body] of [
      ["GET", `${CHAT_PATH}/made-up`, undefined],
      ["GET", `${CHAT_PATH}/made-up/events?after=0`, undefined],
      ["POST", `${CHAT_PATH}/made-up/turn`, { text: "hello" }],
    ] as const) {
      const response = await call<{ error: string }>(handler, method, path, body);
      expect([method, response.status]).toEqual([method, 404]);
      expect(response.body.error).toBe("UnknownChat");
    }
  });

  it("rejects a body that names no loop, no text, or a nonsense ticket", async () => {
    const handler = handlerFor(worktree());
    expect((await call(handler, "POST", CHAT_PATH, {})).status).toBe(400);
    expect((await call(handler, "POST", CHAT_PATH, { loop: "ralph", ticket: "252" })).status).toBe(400);
    const started = await call<{ id: string }>(handler, "POST", CHAT_PATH, { loop: "ralph" });
    expect((await call(handler, "POST", `${CHAT_PATH}/${started.body.id}/turn`, {})).status).toBe(400);
  });

  it("answers the wrong method with 405, not with a chat", async () => {
    const handler = handlerFor(worktree());
    expect((await call(handler, "GET", CHAT_PATH)).status).toBe(405);
    const started = await call<{ id: string }>(handler, "POST", CHAT_PATH, { loop: "ralph" });
    expect((await call(handler, "GET", `${CHAT_PATH}/${started.body.id}/turn`)).status).toBe(405);
    expect((await call(handler, "DELETE", `${CHAT_PATH}/${started.body.id}/events`)).status).toBe(405);
  });

  it("closes a chat, and then does not know it", async () => {
    const handler = handlerFor(worktree());
    const started = await call<{ id: string }>(handler, "POST", CHAT_PATH, { loop: "ralph" });
    expect((await call(handler, "DELETE", `${CHAT_PATH}/${started.body.id}`)).status).toBe(204);
    const gone = await call<{ error: string }>(handler, "GET", `${CHAT_PATH}/${started.body.id}`);
    expect([gone.status, gone.body.error]).toEqual([404, "UnknownChat"]);
  });
});

describe("the evidence a chat is seeded with", () => {
  const journal: JournalEntryView[] = [{ name: "20261007T132808Z-2013-5e6fce5f-e1c.md", at: null, issue: 2013, loop: "rafa", title: "#2013", outcome: "blocked" }];
  const stuck: StuckReason = {
    number: 2013,
    title: "visual baseline",
    kind: "other",
    reason: "blocked: needs build 3191's PNG",
    pr: 2020,
    migration: null,
    at: "2026-10-07T13:27:00Z",
    park: null,
  };
  // Only the fields `evidenceOf` reads: the rest of the snapshot is the
  // aggregation's business, and is exercised by the route tests above.
  const dashboard = (frontier: Dashboard["frontier"]): Dashboard =>
    ({ loops: [{ loop: "rafa", issue: 2013, journal }], frontier }) as unknown as Dashboard;
  const read = (stuckReasons: StuckReason[]): Dashboard["frontier"] =>
    ({ readAt: "2026-10-07T13:30:00Z", view: { stuckReasons } }) as unknown as Dashboard["frontier"];

  it("takes the block record, ticket and journal off the snapshot the card was drawn from", () => {
    expect(evidenceOf(dashboard(read([stuck])), "rafa", { kind: "ticket", ticket: 2013 })).toEqual({
      ticket: 2013,
      block: { kind: "other", reason: "blocked: needs build 3191's PNG", pr: 2020, migration: null, at: "2026-10-07T13:27:00Z" },
      journal,
    });
  });

  it("is about the loop's own ticket for a halt", () => {
    expect(evidenceOf(dashboard(read([stuck])), "rafa", { kind: "halt" }).ticket).toBe(2013);
  });

  it("has no block when the frontier holds none for the ticket, or was not read", () => {
    expect(evidenceOf(dashboard(read([stuck])), "rafa", { kind: "ticket", ticket: 7 }).block).toBeNull();
    expect(evidenceOf(dashboard(null), "rafa", { kind: "ticket", ticket: 2013 }).block).toBeNull();
    expect(evidenceOf(dashboard(null), "nobody", { kind: "halt" })).toEqual({ ticket: null, block: null, journal: null });
  });
});
