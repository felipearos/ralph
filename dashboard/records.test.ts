// @vitest-environment node
import { describe, expect, it } from "vitest";

import { FEED_LIMIT, historyView, mergeFeeds, notificationFeed, raisedAt, raisedRows, type RawFile, type RawHistory } from "./records";

const read = (text: string): RawFile => ({ state: "read", text });
const lines = (...rows: unknown[]): RawFile => read(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
const missing: RawFile = { state: "missing" };

const raised = (id: string, at: string, extra: Record<string, unknown> = {}) => ({
  version: 1,
  event: "raised",
  id,
  at,
  run: "ralph-run-1",
  loop: "ralph",
  kind: "gate-failure",
  subject: "Loop gate failed at gate-broken",
  body: "token [redacted:env:GH_TOKEN] rejected",
  priority: "high",
  ticket: 52,
  iteration: 3,
  plugins: [],
  github: "absent",
  ...extra,
});

describe("the notification feed", () => {
  it("lists each alert newest first with its kind, ticket, iteration, time and redacted text", () => {
    const feed = notificationFeed("ralph", {
      feed: lines(raised("r:a", "2026-09-22T10:00:00.000Z"), raised("r:b", "2026-09-22T11:00:00.000Z", { kind: "no-sigil", ticket: null, iteration: null })),
      readMark: missing,
    });

    expect(feed.problem).toBeNull();
    expect(feed.notifications.map((entry) => entry.id)).toEqual(["r:b", "r:a"]);
    expect(feed.notifications[1]).toMatchObject({
      loop: "ralph",
      run: "ralph-run-1",
      kind: "gate-failure",
      ticket: 52,
      iteration: 3,
      at: "2026-09-22T10:00:00.000Z",
      body: "token [redacted:env:GH_TOKEN] rejected",
      read: false,
      deliveries: [],
    });
    expect(feed.notifications[0]).toMatchObject({ kind: "no-sigil", ticket: null, iteration: null });
    expect(feed.unread).toBe(2);
  });

  it("shows how each plugin and the ticket comment took an alert, and never drops one that did not arrive", () => {
    const feed = notificationFeed("ralph", {
      feed: lines(
        raised("r:a", "2026-09-22T10:00:00.000Z", { plugins: ["pager", "orca", "slack", "mail"], github: "eligible" }),
        { version: 1, event: "delivery", id: "r:a", at: "2026-09-22T10:00:01.000Z", channel: "plugin", name: "pager", ok: false, ran: false, why: "plugin 'pager' is enabled but not installed" },
        { version: 1, event: "delivery", id: "r:a", at: "2026-09-22T10:00:02.000Z", channel: "plugin", name: "orca", ok: false, ran: true, why: "no Orca Run to send the alert to" },
        { version: 1, event: "delivery", id: "r:a", at: "2026-09-22T10:00:03.000Z", channel: "plugin", name: "slack", ok: true, ran: true, why: null },
        { version: 1, event: "delivery", id: "r:a", at: "2026-09-22T10:00:04.000Z", channel: "github", name: "github", ok: true, why: null, outcome: "posted" },
      ),
      readMark: missing,
    });

    expect(feed.notifications[0]!.deliveries).toEqual([
      { channel: "plugin", name: "pager", state: "skipped", why: "plugin 'pager' is enabled but not installed", at: "2026-09-22T10:00:01.000Z" },
      { channel: "plugin", name: "orca", state: "failed", why: "no Orca Run to send the alert to", at: "2026-09-22T10:00:02.000Z" },
      { channel: "plugin", name: "slack", state: "delivered", why: null, at: "2026-09-22T10:00:03.000Z" },
      // Offered, and no answer was ever written: nobody can say it arrived.
      { channel: "plugin", name: "mail", state: "unconfirmed", why: "no answer was recorded", at: null },
      { channel: "github", name: "github", state: "delivered", why: null, at: "2026-09-22T10:00:04.000Z" },
    ]);
  });

  it("says why a ticket comment was not posted", () => {
    const feed = notificationFeed("ralph", {
      feed: lines(
        raised("r:a", "2026-09-22T10:00:00.000Z", { github: "unheld" }),
        raised("r:b", "2026-09-22T10:01:00.000Z", { github: "eligible" }),
        { version: 1, event: "delivery", id: "r:b", at: "2026-09-22T10:01:01.000Z", channel: "github", name: "github", ok: false, why: "capped at 5", outcome: "capped" },
        raised("r:c", "2026-09-22T10:02:00.000Z", { github: "eligible" }),
      ),
      readMark: missing,
    });
    const byId = new Map(feed.notifications.map((entry) => [entry.id, entry.deliveries]));

    expect(byId.get("r:a")).toEqual([
      { channel: "github", name: "github", state: "skipped", why: "the run held no live claim on #52 when the alert was raised", at: null },
    ]);
    expect(byId.get("r:b")).toEqual([
      { channel: "github", name: "github", state: "skipped", why: "capped at 5", at: "2026-09-22T10:01:01.000Z" },
    ]);
    expect(byId.get("r:c")).toEqual([
      { channel: "github", name: "github", state: "unconfirmed", why: "no answer was recorded", at: null },
    ]);
  });

  it("marks alerts at or before the read mark as read", () => {
    const feed = notificationFeed("ralph", {
      feed: lines(raised("r:a", "2026-09-22T10:00:00.000Z"), raised("r:b", "2026-09-22T11:00:00.000Z")),
      readMark: read(JSON.stringify({ version: 1, readThrough: "2026-09-22T10:00:00.000Z" })),
    });

    expect(feed.readThrough).toBe("2026-09-22T10:00:00.000Z");
    expect(feed.notifications.map((entry) => [entry.id, entry.read])).toEqual([
      ["r:b", false],
      ["r:a", true],
    ]);
    expect(feed.unread).toBe(1);
  });

  it("degrades to an explained empty feed, and skips lines it cannot read", () => {
    expect(notificationFeed("ralph", { feed: missing, readMark: missing })).toMatchObject({
      notifications: [],
      unread: 0,
      problem: { kind: "missing" },
    });
    expect(
      notificationFeed("ralph", { feed: { state: "unreadable", why: "EACCES" }, readMark: missing }).problem,
    ).toEqual({ kind: "unreadable", detail: expect.stringContaining("EACCES") });

    const partial = notificationFeed("ralph", {
      feed: read(`not json\n${JSON.stringify({ event: "raised" })}\n${JSON.stringify(raised("r:a", "2026-09-22T10:00:00.000Z"))}\n{"trunc`),
      // A read mark that is not one is no mark at all.
      readMark: read("{"),
    });
    expect(partial.notifications.map((entry) => entry.id)).toEqual(["r:a"]);
    expect(partial.readThrough).toBeNull();
    expect(partial.problem).toBeNull();
  });

  it("folds an alert written twice into one, at its first time, with the claimed line's channels", () => {
    const feed = notificationFeed("ralph", {
      feed: lines(
        // Written when the record could not be claimed, then by the replay that claimed it.
        raised("r:a", "2026-09-22T10:00:00.000Z", { unsent: "the notification record could not be locked, so nothing was sent" }),
        raised("r:a", "2026-09-22T10:05:00.000Z", { plugins: ["board"] }),
        { version: 1, event: "delivery", id: "r:a", at: "2026-09-22T10:05:01.000Z", channel: "plugin", name: "board", ok: true, ran: true, why: null },
      ),
      readMark: missing,
    });
    expect(feed.notifications).toHaveLength(1);
    expect(feed.notifications[0]).toMatchObject({ at: "2026-09-22T10:00:00.000Z", deliveries: [expect.objectContaining({ name: "board", state: "delivered" })] });
  });

  it("never lets an unsent line written after the claimed one hide its deliveries", () => {
    const feed = notificationFeed("ralph", {
      feed: lines(
        raised("r:a", "2026-09-22T10:00:00.000Z", { plugins: ["board"] }),
        { version: 1, event: "delivery", id: "r:a", at: "2026-09-22T10:00:01.000Z", channel: "plugin", name: "board", ok: true, ran: true, why: null },
        // A racing sender that timed out on the lock, after the winner wrote.
        raised("r:a", "2026-09-22T10:00:15.000Z", { unsent: "the notification record could not be locked, so nothing was sent" }),
      ),
      readMark: missing,
    });
    expect(feed.notifications[0]).toMatchObject({ unsent: null, deliveries: [expect.objectContaining({ name: "board", state: "delivered" })] });
  });

  it("says why an alert was sent nowhere but the feed", () => {
    const feed = notificationFeed("ralph", {
      feed: lines(raised("r:a", "2026-09-22T10:00:00.000Z", { unsent: "pushes are switched off (RALPH_PUSH_NOTIFICATIONS=0)" })),
      readMark: missing,
    });
    expect(feed.notifications[0]).toMatchObject({ deliveries: [], unsent: expect.stringContaining("switched off") });
  });

  it("merges every loop's feed newest first", () => {
    const ralph = notificationFeed("ralph", { feed: lines(raised("r:a", "2026-09-22T10:00:00.000Z")), readMark: missing });
    const rafa = notificationFeed("rafa", {
      feed: lines(raised("f:a", "2026-09-22T12:00:00.000Z", { loop: "rafa" })),
      readMark: read(JSON.stringify({ version: 1, readThrough: "2026-09-22T12:00:00.000Z" })),
    });
    const merged = mergeFeeds([ralph, rafa], "2026-09-22T13:00:00.000Z");

    expect(merged.recent.map((entry) => [entry.loop, entry.id])).toEqual([
      ["rafa", "f:a"],
      ["ralph", "r:a"],
    ]);
    expect(merged.unread).toBe(1);
  });
});

const command = (stem: string, value: Record<string, unknown>, outcome: Record<string, unknown> | null, pending = false) => ({
  stem,
  pending,
  modifiedAt: "2026-09-22T09:00:00.000Z",
  command: read(JSON.stringify({ version: 1, id: stem, ...value })),
  outcome: outcome === null ? missing : read(JSON.stringify(outcome)),
});

const history = (overrides: Partial<RawHistory> = {}): RawHistory => ({
  commands: { state: "missing" },
  signals: missing,
  repairs: missing,
  ...overrides,
});

describe("counting one kind of alert (the reconciler's bound)", () => {
  // `notificationFeed` above is the page's projection and keeps the 100
  // newest alerts of every kind together. The reconciler's bound is counted
  // from one kind, so it reads `raisedAt` instead; these are the properties
  // the bound rests on.
  const restart = (id: string, at: string, extra: Record<string, unknown> = {}) =>
    raised(id, at, { kind: "loop-restarted", ticket: null, iteration: null, ...extra });

  it("finds every alert of its kind, however many others are in front of it", () => {
    // The limit this function exists to escape: a chatty loop would otherwise
    // hide its own restart records behind a hundred unrelated alerts, the
    // count would read zero, and nothing would bound the restarts.
    const noise = Array.from({ length: 120 }, (_, index) =>
      raised(`noise:${String(index)}`, new Date(Date.parse("2026-09-22T12:00:00.000Z") + index * 1_000).toISOString()),
    );
    const feed = lines(
      restart("r:a", "2026-09-22T10:00:00.000Z"),
      restart("r:b", "2026-09-22T11:00:00.000Z"),
      ...noise,
    );
    expect(raisedAt(feed, "loop-restarted")).toEqual(["2026-09-22T11:00:00.000Z", "2026-09-22T10:00:00.000Z"]);
    // And this is why it is not `notificationFeed`: the page's projection
    // drops both of them, which as a count would read as "no attempts yet".
    const shown = notificationFeed("ralph", { feed, readMark: missing }).notifications;
    expect(shown).toHaveLength(FEED_LIMIT);
    expect(shown.map((entry) => entry.id)).not.toContain("r:a");
    expect(shown.filter((entry) => entry.kind === "loop-restarted")).toEqual([]);
  });

  it("counts one alert once, keeping the first time it was written", () => {
    // An alert is raised once and may be written twice — an `unsent` line and
    // the sender's, in either order. Counting both would trip the bound a
    // third early.
    const feed = lines(
      restart("r:a", "2026-09-22T10:00:00.000Z", { unsent: "pushes are switched off" }),
      restart("r:a", "2026-09-22T10:00:02.000Z"),
    );
    expect(raisedAt(feed, "loop-restarted")).toEqual(["2026-09-22T10:00:00.000Z"]);
  });

  it("ignores another kind, a delivery line, and a time that is not one", () => {
    const feed = lines(
      restart("r:a", "2026-09-22T10:00:00.000Z"),
      raised("g:a", "2026-09-22T10:30:00.000Z"),
      restart("r:b", "whenever"),
      { version: 1, event: "delivery", id: "r:a", at: "2026-09-22T10:00:01.000Z", channel: "plugin", name: "slack", ok: true },
    );
    expect(raisedAt(feed, "loop-restarted")).toEqual(["2026-09-22T10:00:00.000Z", "whenever"]);
    expect(raisedAt(feed, "loop-restart-capped")).toEqual([]);
  });

  it("separates a record that is not there from one it could not read", () => {
    // The whole bound is counted from this file: unreadable read as "no
    // attempts yet" would leave the restarts unbounded, so it is null and the
    // reconciler leaves the loop alone.
    expect(raisedAt(missing, "loop-restarted")).toEqual([]);
    expect(raisedAt({ state: "unreadable", why: "EACCES" }, "loop-restarted")).toBeNull();
  });
});

describe("one kind of alert with its retry payload (the retry view)", () => {
  const retried = (id: string, at: string, retry: unknown, extra: Record<string, unknown> = {}) =>
    raised(id, at, { kind: "loop-retried", ticket: null, iteration: null, retry, ...extra });

  it("returns each alert's id, time and raw retry payload, newest first", () => {
    const feed = lines(
      retried("r:a", "2026-10-20T10:00:00.000Z", { attempt: 1, of: 3, cause: "no-sigil" }),
      retried("r:b", "2026-10-20T11:00:00.000Z", { attempt: 2, of: 3, cause: "no-sigil" }),
      retried("r:c", "2026-10-20T10:30:00.000Z", undefined),
    );
    expect(raisedRows(feed, "loop-retried")).toEqual([
      { id: "r:b", at: "2026-10-20T11:00:00.000Z", retry: { attempt: 2, of: 3, cause: "no-sigil" } },
      { id: "r:c", at: "2026-10-20T10:30:00.000Z", retry: undefined },
      { id: "r:a", at: "2026-10-20T10:00:00.000Z", retry: { attempt: 1, of: 3, cause: "no-sigil" } },
    ]);
  });

  it("keeps the first row of an alert written twice, its time and its payload both", () => {
    const feed = lines(
      retried("r:a", "2026-10-20T10:00:00.000Z", { attempt: 1, of: 3, cause: "no-sigil" }, { unsent: "pushes are switched off" }),
      retried("r:a", "2026-10-20T10:00:02.000Z", { attempt: 9, of: 9, cause: "other" }),
    );
    expect(raisedRows(feed, "loop-retried")).toEqual([
      { id: "r:a", at: "2026-10-20T10:00:00.000Z", retry: { attempt: 1, of: 3, cause: "no-sigil" } },
    ]);
  });

  it("ignores another kind, and separates unreadable from not there", () => {
    const feed = lines(raised("g:a", "2026-10-20T10:30:00.000Z"), raised("x:a", "2026-10-20T10:40:00.000Z", { kind: "loop-retry-capped" }));
    expect(raisedRows(feed, "loop-retried")).toEqual([]);
    expect(raisedRows(missing, "loop-retried")).toEqual([]);
    expect(raisedRows({ state: "unreadable", why: "EACCES" }, "loop-retried")).toBeNull();
  });
});

describe("the audit history", () => {
  it("lists commands, signals and repairs in time order, newest first, each with its outcome and reason", () => {
    const view = historyView(
      "ralph",
      history({
        commands: {
          state: "read",
          files: [
            command(
              "c-pause",
              { command: "pause", loop: "ralph", run: "ralph-run-1", why: "lunch", issuedAt: "2026-09-22T10:00:00.000Z" },
              { key: "c-pause", command: "pause", outcome: "applied", why: "paused — lunch", at: "2026-09-22T10:00:05.000Z" },
            ),
            command(
              "c-stop",
              { command: "stop", loop: "ralph", run: "ralph-run-2", stop: "blocked", issuedAt: "2026-09-22T12:00:00.000Z" },
              null,
              true,
            ),
          ],
        },
        signals: lines(
          { id: "now-1", at: "2026-09-22T11:00:00.000Z", event: "signal", loop: "ralph", run: "ralph-run-1", reason: "stuck turn", target: {}, checks: [], signal: "SIGTERM", outcome: null, detail: "sending SIGTERM" },
          { id: "now-1", at: "2026-09-22T11:00:03.000Z", event: "outcome", loop: "ralph", run: "ralph-run-1", reason: "stuck turn", target: {}, checks: [], signal: "SIGTERM", outcome: "interrupted", detail: "ralph was interrupted" },
        ),
        repairs: lines(
          { version: 1, at: "2026-09-22T10:30:00.000Z", plugin: "orca", run: "ralph-run-1", kind: "diagnosis", via: "operator", check: null, action: null, result: "fail", why: "" },
          { version: 1, at: "2026-09-22T10:31:00.000Z", plugin: "orca", run: "ralph-run-1", kind: "repair", via: "operator", check: "consumer", action: "rebind", result: "repaired", why: "bound terminal t1" },
        ),
      }),
      "2026-09-22T13:00:00.000Z",
    );

    expect(view.problems).toEqual([]);
    expect(view.entries.map((entry) => [entry.source, entry.action, entry.outcome])).toEqual([
      ["command", "stop", "pending"],
      ["signal", "stop-now", "interrupted"],
      ["repair", "orca consumer: rebind", "repaired"],
      ["command", "pause", "applied"],
    ]);
    expect(view.entries[0]).toMatchObject({ run: "ralph-run-2", at: "2026-09-22T12:00:00.000Z", detail: "waiting in the inbox for the loop's next poll" });
    expect(view.entries[1]).toMatchObject({ reason: "stuck turn", detail: "ralph was interrupted", signals: ["SIGTERM"], at: "2026-09-22T11:00:00.000Z" });
    expect(view.entries[2]).toMatchObject({ detail: "bound terminal t1", via: "operator" });
    expect(view.entries[3]).toMatchObject({ reason: "lunch", detail: "paused — lunch", via: null });
  });

  it("carries a refusal's recorded reason, not merely that it failed", () => {
    const view = historyView(
      "ralph",
      history({
        commands: {
          state: "read",
          files: [
            command(
              "c-abandon",
              { command: "abandon", loop: "ralph", issue: 52, why: "owner is gone", issuedAt: "2026-09-22T10:00:00.000Z" },
              { key: "c-abandon", command: "abandon", outcome: "refused", why: "#52 is held by rafa-run-1 until 2026-09-22T11:00:00.000Z — not expired", at: "2026-09-22T10:00:01.000Z" },
            ),
            command(
              "c-stop",
              { command: "stop", loop: "ralph", run: "ralph-run-0", via: "orca", issuedAt: "2026-09-22T10:10:00.000Z" },
              { key: "c-stop", command: "stop", outcome: "needs-reconfirmation", why: "issued against run ralph-run-0, which ralph-run-1 replaced", at: "2026-09-22T10:10:01.000Z" },
            ),
          ],
        },
        signals: lines({
          id: "now-2",
          at: "2026-09-22T10:20:00.000Z",
          event: "refused",
          loop: "ralph",
          run: "ralph-run-1",
          reason: "hung",
          target: { pidFile: ".ralph/logs/supervisor.pid", pid: 4242, group: null },
          checks: [
            { check: "pid-file", ok: true, detail: "pid 4242" },
            { check: "ralph.sh", ok: false, detail: "pid 4242 is running vim" },
          ],
          signal: null,
          outcome: "refused",
          detail: "nothing was signalled: pid 4242 is running vim",
        }),
      }),
      "2026-09-22T13:00:00.000Z",
    );
    const byAction = new Map(view.entries.map((entry) => [entry.action, entry]));

    expect(byAction.get("abandon")).toMatchObject({ outcome: "refused", issue: 52, reason: "owner is gone", detail: expect.stringContaining("not expired") });
    expect(byAction.get("stop")).toMatchObject({ outcome: "needs-reconfirmation", via: "orca", detail: expect.stringContaining("ralph-run-1 replaced") });
    expect(byAction.get("stop-now")).toMatchObject({
      outcome: "refused",
      failedCheck: "ralph.sh",
      detail: "nothing was signalled: pid 4242 is running vim",
      reason: "hung",
      signals: [],
    });
  });

  it("shows a Stop now that signalled and never said how it ended as pending", () => {
    const view = historyView(
      "ralph",
      history({
        signals: lines({ id: "now-3", at: "2026-09-22T10:00:00.000Z", event: "signal", loop: "ralph", run: null, reason: "", target: {}, checks: [], signal: "SIGTERM", outcome: null, detail: "sending SIGTERM" }),
      }),
      "2026-09-22T13:00:00.000Z",
    );
    expect(view.entries[0]).toMatchObject({ outcome: "pending", signals: ["SIGTERM"], reason: null });
  });

  it("says who asked for a Stop now when its audit lines name a via", () => {
    const line = { at: "2026-09-22T10:00:00.000Z", event: "refused", loop: "ralph", run: null, reason: "", target: {}, checks: [], signal: null, outcome: "refused", detail: "x" };
    const view = historyView(
      "ralph",
      history({ signals: lines({ ...line, id: "now-r", via: "remote" }, { ...line, id: "now-l", at: "2026-09-22T09:00:00.000Z" }) }),
      "2026-09-22T13:00:00.000Z",
    );
    expect(view.entries.map((entry) => [entry.id, entry.via])).toEqual([
      ["now-r", "remote"],
      ["now-l", null],
    ]);
  });

  it("degrades each missing or unreadable record to an explained problem, never a failure", () => {
    const view = historyView(
      "ralph",
      history({ commands: { state: "unreadable", why: "EACCES" }, signals: read("garbage\n"), repairs: missing }),
      "2026-09-22T13:00:00.000Z",
    );
    expect(view.entries).toEqual([]);
    expect(view.problems).toEqual([
      { source: "command", problem: { kind: "unreadable", detail: expect.stringContaining("EACCES") } },
      { source: "repair", problem: { kind: "missing", detail: expect.any(String) } },
    ]);
  });

  it("lists a file the loop settled as malformed by its recorded outcome", () => {
    const view = historyView(
      "ralph",
      history({
        commands: {
          state: "read",
          files: [
            {
              stem: "typo",
              pending: false,
              modifiedAt: "2026-09-22T08:00:00.000Z",
              command: read("{not json"),
              outcome: read(JSON.stringify({ key: null, command: null, outcome: "malformed", why: "not valid JSON", at: "2026-09-22T08:00:01.000Z" })),
            },
          ],
        },
      }),
      "2026-09-22T13:00:00.000Z",
    );
    expect(view.entries).toEqual([
      expect.objectContaining({ id: "typo", action: "unreadable command", outcome: "malformed", detail: "not valid JSON", at: "2026-09-22T08:00:01.000Z" }),
    ]);
  });

  it("skips a command file it cannot read, and uses the file's time when the command names none", () => {
    const view = historyView(
      "ralph",
      history({
        commands: {
          state: "read",
          files: [
            { stem: "broken", pending: false, modifiedAt: null, command: read("{"), outcome: missing },
            { stem: "hand", pending: true, modifiedAt: "2026-09-22T08:00:00.000Z", command: read(JSON.stringify({ command: "pause" })), outcome: missing },
          ],
        },
      }),
      "2026-09-22T13:00:00.000Z",
    );
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]).toMatchObject({ id: "hand", action: "pause", outcome: "pending", at: "2026-09-22T08:00:00.000Z" });
  });
});
