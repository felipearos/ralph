// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { HistoryView, NotificationFeed, NotificationView } from "../contracts";
import { deliveryLine, emptyFeed, historyNotes, newestAt, outcomeTone, unreadMarks } from "./feed-model";

const alert = (id: string, at: string, read = false, deliveries: NotificationView["deliveries"] = []): NotificationView => ({
  id,
  loop: "ralph",
  run: "run-1",
  kind: "gate-failure",
  subject: "Gate failed",
  body: "",
  priority: "high",
  ticket: 52,
  iteration: 2,
  at,
  read,
  deliveries,
  unsent: null,
});

describe("the feed's words", () => {
  it("says which channel did not take an alert, and why", () => {
    const failed = { channel: "plugin" as const, name: "orca", state: "failed" as const, why: "no Orca Run to send the alert to", at: null };
    expect(deliveryLine(failed)).toBe("orca: not delivered — no Orca Run to send the alert to");
    expect(deliveryLine({ channel: "github", name: "github", state: "delivered", why: null, at: null })).toBe("ticket comment: delivered");
  });

  it("marks read through the newest unread alert of each loop that has one", () => {
    expect(newestAt([alert("a", "2026-09-22T10:00:00Z"), alert("b", "2026-09-22T12:00:00Z"), alert("c", "2026-09-22T11:00:00Z")])).toBe("2026-09-22T12:00:00Z");
    const feed = (loop: string, notifications: NotificationView[]): NotificationFeed => ({
      loop,
      notifications,
      unread: notifications.filter((entry) => !entry.read).length,
      readThrough: null,
      problem: null,
    });
    expect(
      unreadMarks([
        feed("ralph", [alert("a", "2026-09-22T10:00:00Z"), alert("b", "2026-09-22T09:00:00Z")]),
        feed("rafa", [alert("c", "2026-09-22T11:00:00Z", true)]),
      ]),
    ).toEqual([{ loop: "ralph", through: "2026-09-22T10:00:00Z" }]);
  });

  it("explains an empty feed by its cause", () => {
    expect(emptyFeed({ kind: "missing", detail: "" }).text).toMatch(/no alerts yet/);
    expect(emptyFeed({ kind: "unreadable", detail: "EACCES" })).toEqual({ text: "The feed could not be read: EACCES", tone: "warn" });
  });
});

describe("the history's words", () => {
  it("tones a refusal as bad and a pending command as waiting", () => {
    expect(outcomeTone("refused")).toBe("bad");
    expect(outcomeTone("needs-reconfirmation")).toBe("warn");
    expect(outcomeTone("pending")).toBe("info");
    expect(outcomeTone("something-new")).toBe("neutral");
  });

  it("warns only about records that exist and could not be read", () => {
    const view: HistoryView = {
      loop: "ralph",
      generatedAt: "2026-09-22T13:00:00Z",
      entries: [],
      problems: [
        { source: "command", problem: { kind: "missing", detail: "none" } },
        { source: "signal", problem: { kind: "unreadable", detail: "the Stop now audit could not be read: EACCES" } },
      ],
    };
    expect(historyNotes(view)).toEqual({
      empty: "No commands, signals or repairs have been recorded for this loop.",
      warnings: ["signals: the Stop now audit could not be read: EACCES"],
    });
  });
});
