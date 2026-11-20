// @vitest-environment node
/**
 * The notification feed and the audit history, driven in-process through the
 * real handler over a scratch checkout whose records were written by the real
 * writers: `push-notification.ts` for the feed, `control-inbox.ts` for settled
 * commands and the Stop now adapter for its audit. What the harness writes is
 * what the page reads.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { settleInboxEntry, writeInboxCommand } from "../control-inbox";
import { coderRoster } from "./contracts";
import type { HistoryView, MarkReadResult, NotificationFeed, NotificationsView, RuntimeSnapshot } from "./contracts";
import { createInterruptAdapter } from "./interrupt-adapter";
import { createRecordsAdapter } from "./records-adapter";
import { createHandler } from "./server";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("reads records through bash CLIs");

const HARNESS = join(__dirname, "..");
const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `ralph-records-${label}-`));
  roots.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  return root;
}

function runtimeFor(root: string | null): RuntimeSnapshot {
  return {
    roster: coderRoster("ralph", "rafa"),
    loops:
      root === null
        ? []
        : [
            {
              worktree: root,
              identity: "ralph",
              loopStatus: "running",
              worktreeStatus: "live",
              branch: "ralph/52",
              state: {
                version: 1,
                run: "ralph-run-1",
                owner: { loop: "ralph", pid: null, host: "test" },
                worktree: root,
                branch: "ralph/52",
                stage: "iteration",
                iteration: { index: 3, max: 10 },
                heartbeat: "2026-09-22T00:00:00.000Z",
                lastEvent: null,
                stopReason: null,
              },
              stateProblem: null,
              supervisor: "alive",
              presence: null,
            },
          ],
    reconciliation: { orphaned: [], prunable: [] },
  };
}

const handlerFor = (root: string | null) =>
  createHandler({
    adapter: { read: async () => runtimeFor(root) },
    shell: "<html></html>",
    clock: () => ({ nowMs: Date.parse("2026-09-22T13:00:00.000Z") }),
    records: (worktree) => createRecordsAdapter({ root: worktree }),
  });

const get = async <T,>(handler: (request: Request) => Promise<Response>, path: string): Promise<{ status: number; body: T }> => {
  const response = await handler(new Request(`http://127.0.0.1${path}`));
  return { status: response.status, body: (await response.json()) as T };
};

/** Raise one alert through the real notifier, with no plugin and no ticket, so nothing leaves the machine. */
function raise(
  root: string,
  occurrence: string,
  extra: Record<string, string> = {},
  alert: { kind?: string; subject?: string; body?: string } = {},
): void {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  // Nothing should call gh or orca; a call would fail the test by leaving a trace.
  for (const command of ["gh", "orca"]) {
    writeFileSync(join(bin, command), `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(join(root, "calls"))}\nexit 1\n`);
    chmodSync(join(bin, command), 0o755);
  }
  const ran = spawnSync(
    BUN,
    [
      join(HARNESS, "push-notification.ts"),
      "push",
      "--kind",
      alert.kind ?? "gate-failure",
      "--occurrence",
      occurrence,
      "--subject",
      alert.subject ?? "Gate failed",
      "--body",
      alert.body ?? "token secret-feed-value-9 was rejected",
      "--priority",
      "high",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RALPH_STATE_ROOT: root,
        RALPH_RUN_ID: "ralph-run-1",
        RALPH_LOOP_NAME: "ralph",
        RALPH_ITERATION: "3",
        RALPH_PLUGINS: "",
        RALPH_PUSH_NOTIFICATIONS: "1",
        TEST_FEED_SECRET: "secret-feed-value-9",
        ...extra,
      },
    },
  );
  expect(ran.status).toBe(0);
}

describe("the notification feed routes", () => {
  it("serve every alert the loop raised with no plugin enabled, redacted, and mark them read", async () => {
    const root = scratch("feed");
    raise(root, "gate:1");
    const handler = handlerFor(root);

    const feed = await get<NotificationFeed>(handler, "/api/loops/ralph/notifications");
    expect(feed.status).toBe(200);
    expect(feed.body.problem).toBeNull();
    expect(feed.body.notifications).toHaveLength(1);
    const [alert] = feed.body.notifications;
    expect(alert).toMatchObject({ loop: "ralph", kind: "gate-failure", ticket: null, iteration: 3, read: false, deliveries: [] });
    expect(JSON.stringify(feed.body)).not.toContain("secret-feed-value-9");
    expect(alert!.body).toContain("[redacted:env:TEST_FEED_SECRET]");
    expect(existsSync(join(root, "calls"))).toBe(false);

    const all = await get<NotificationsView>(handler, "/api/notifications");
    expect(all.body.unread).toBe(1);
    expect(all.body.recent.map((entry) => entry.id)).toEqual([alert!.id]);
    // A roster loop with no checkout is listed, with why it has no feed.
    expect(all.body.loops.find((entry) => entry.loop === "rafa")?.problem).toMatchObject({ kind: "no-checkout" });

    const marked = await handler(
      new Request("http://127.0.0.1/api/notifications/read", { method: "POST", body: JSON.stringify({ loop: "ralph", through: alert!.at }) }),
    );
    expect(marked.status).toBe(200);
    expect((await marked.json()) as MarkReadResult).toEqual({ loop: "ralph", readThrough: alert!.at, recorded: true, why: null });
    // The mark lives in the control directory, which ignores itself.
    expect(readFileSync(join(root, ".ralph", "control", ".gitignore"), "utf8")).toBe("*\n");

    // A page that was behind cannot unread what has been seen.
    await handler(
      new Request("http://127.0.0.1/api/notifications/read", { method: "POST", body: JSON.stringify({ loop: "ralph", through: "2020-01-01T00:00:00.000Z" }) }),
    );
    const after = await get<NotificationFeed>(handler, "/api/loops/ralph/notifications");
    expect(after.body.unread).toBe(0);
    expect(after.body.notifications[0]!.read).toBe(true);
  });

  it("show a restart the reconciler recorded, with its time and its reason (#346)", async () => {
    // The feed is where #329's "the dashboard shows when a loop was restarted,
    // and why" is answered, and it needs no new shape to do it: the record the
    // reconciler pushes arrives as an ordinary `NotificationView`. Written
    // here through the real notifier, under the reconciler's own occurrence
    // key and environment.
    const root = scratch("loop-restarted");
    const at = "2026-10-20T12:00:00.000Z";
    raise(root, `loop-restarted:software-factory:ralph:${at}`, {}, {
      kind: "loop-restarted",
      subject: "ralph (software-factory): restart restarted",
      body: [
        "project: software-factory",
        "loop: ralph",
        `worktree: ${root}`,
        "dead run: ralph-run-dead",
        "reason: supervisor 4242 gone, no stopReason",
        "outcome: restarted (pid 5151) — Started Ralph supervisor (pid 5151)",
      ].join("\n"),
    });

    const feed = await get<NotificationFeed>(handlerFor(root), "/api/loops/ralph/notifications");
    const [alert] = feed.body.notifications;
    expect(alert).toMatchObject({ loop: "ralph", kind: "loop-restarted", read: false });
    // Its time is the record's own, and its reason and outcome are readable
    // on the page without anybody opening a log.
    expect(Date.parse(alert!.at)).not.toBeNaN();
    expect(alert!.body).toContain("reason: supervisor 4242 gone, no stopReason");
    expect(alert!.body).toContain("outcome: restarted (pid 5151)");
    expect(alert!.subject).toContain("software-factory");
  });

  it("show an alert a plugin could not take as undelivered", async () => {
    const root = scratch("undelivered");
    // Orca on, with no Orca Run on record: the plugin answers that it had nowhere to send it.
    raise(root, "gate:2", { RALPH_PLUGINS: "orca", RALPH_ORCA_CLI: join(root, "bin", "orca") });

    const feed = await get<NotificationFeed>(handlerFor(root), "/api/loops/ralph/notifications");
    expect(feed.body.notifications[0]!.deliveries).toEqual([
      expect.objectContaining({ channel: "plugin", name: "orca", state: "failed", why: "no Orca Run to send the alert to" }),
    ]);
  });

  it("explain an empty feed rather than fail, and refuse a malformed read mark", async () => {
    const root = scratch("empty");
    const handler = handlerFor(root);

    const feed = await get<NotificationFeed>(handler, "/api/loops/ralph/notifications");
    expect(feed.status).toBe(200);
    expect(feed.body).toMatchObject({ notifications: [], unread: 0, problem: { kind: "missing" } });
    expect((await get(handler, "/api/loops/nobody/notifications")).status).toBe(404);

    const bad = await handler(new Request("http://127.0.0.1/api/notifications/read", { method: "POST", body: JSON.stringify({ loop: "ralph", through: "yesterday" }) }));
    expect(bad.status).toBe(400);
    const unknown = await handler(new Request("http://127.0.0.1/api/notifications/read", { method: "POST", body: JSON.stringify({ loop: "nobody", through: "2026-09-22T00:00:00Z" }) }));
    expect(unknown.status).toBe(404);
    const absent = await handler(new Request("http://127.0.0.1/api/notifications/read", { method: "POST", body: JSON.stringify({ loop: "rafa", through: "2026-09-22T00:00:00Z" }) }));
    expect(absent.status).toBe(409);
    expect((await handler(new Request("http://127.0.0.1/api/notifications", { method: "POST" }))).status).toBe(405);
    expect((await handler(new Request("http://127.0.0.1/api/notifications/read"))).status).toBe(405);
  });
});

describe("the audit history route", () => {
  it("lists commands, Stop now and repairs, each with its recorded outcome and reason", async () => {
    const root = scratch("history");
    // A release the loop refused because the lease had not expired, settled the way the poller settles it.
    expect(writeInboxCommand(root, { id: "release-1", command: "abandon", loop: "ralph", issue: 52, why: "owner looks gone", issuedAt: "2026-09-22T10:00:00.000Z" })).toBeNull();
    expect(
      settleInboxEntry(
        root,
        { name: "release-1.json", stem: "release-1", path: join(root, ".ralph", "control", "inbox", "release-1.json") },
        { key: "release-1", command: "abandon", outcome: "refused", why: "#52 is held by rafa-run-1 until 2026-09-22T11:00:00.000Z; it has not expired", at: "2026-09-22T10:00:02.000Z" },
      ),
    ).toBeNull();
    // A pause still waiting for the loop's poll.
    expect(writeInboxCommand(root, { id: "pause-1", command: "pause", loop: "ralph", why: "lunch", issuedAt: "2026-09-22T12:00:00.000Z" })).toBeNull();
    // A Stop now refused at the pid check, through the adapter that writes the audit.
    expect(
      createInterruptAdapter({ root }).audit({
        id: "now-1",
        at: "2026-09-22T11:00:00.000Z",
        event: "refused",
        loop: "ralph",
        run: "ralph-run-1",
        reason: "turn held for 40 minutes",
        target: { pidFile: ".ralph/logs/supervisor.pid", pid: 4242, group: null },
        checks: [
          { check: "pid-file", ok: true, detail: "pid 4242" },
          { check: "alive", ok: false, detail: "pid 4242 is not running" },
        ],
        signal: null,
        outcome: "refused",
        detail: "nothing was signalled: pid 4242 is not running",
      }),
    ).toBeNull();
    appendFileSync(
      join(root, ".ralph", "logs", "plugin-doctor.jsonl"),
      `${JSON.stringify({ version: 1, at: "2026-09-22T11:30:00.000Z", plugin: "orca", run: "ralph-run-1", kind: "repair", via: "operator", check: "consumer", action: "rebind", result: "repaired", why: "bound terminal t1" })}\n`,
    );

    const history = await get<HistoryView>(handlerFor(root), "/api/loops/ralph/history");
    expect(history.status).toBe(200);
    expect(history.body.problems).toEqual([]);
    expect(history.body.entries.map((entry) => [entry.source, entry.action, entry.outcome])).toEqual([
      ["command", "pause", "pending"],
      ["repair", "orca consumer: rebind", "repaired"],
      ["signal", "stop-now", "refused"],
      ["command", "abandon", "refused"],
    ]);
    expect(history.body.entries[2]).toMatchObject({ failedCheck: "alive", reason: "turn held for 40 minutes", detail: expect.stringContaining("not running") });
    expect(history.body.entries[3]).toMatchObject({ issue: 52, reason: "owner looks gone", detail: expect.stringContaining("has not expired") });
  });

  it("degrades to an explained empty history when there are no records, or no checkout", async () => {
    const empty = await get<HistoryView>(handlerFor(scratch("no-history")), "/api/loops/ralph/history");
    expect(empty.status).toBe(200);
    expect(empty.body.entries).toEqual([]);
    expect(empty.body.problems.map((entry) => [entry.source, entry.problem.kind])).toEqual([
      ["command", "missing"],
      ["signal", "missing"],
      ["repair", "missing"],
    ]);

    const absent = await get<HistoryView>(handlerFor(null), "/api/loops/ralph/history");
    expect(absent.status).toBe(200);
    expect(absent.body.problems[0]!.problem.kind).toBe("no-checkout");
  });

  it("is not served when no records reader is mounted", async () => {
    const handler = createHandler({ adapter: { read: async () => runtimeFor(null) }, shell: "" });
    expect((await handler(new Request("http://127.0.0.1/api/loops/ralph/history"))).status).toBe(404);
    expect((await handler(new Request("http://127.0.0.1/api/notifications"))).status).toBe(404);
  });
});
