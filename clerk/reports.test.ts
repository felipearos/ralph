// @vitest-environment node
/**
 * Report grouping and the cursor rule, as pure functions (felipearos/ralph#317).
 * The gate's own suite drives the same rules through Slack; these pin the edges
 * that are awkward to stage there.
 */
import { describe, expect, it } from "vitest";

import { BOT, WORKSPACE } from "./fakes";
import { advanceCursor, groupReports, permalink, settled, type GroupInput } from "./reports";
import type { SlackMessage } from "./slack";

const CHANNEL = "C0TESTCHAN1";
const me = { userId: BOT.userId, botId: BOT.botId };
const ts = (minute: number): string => `${1_760_961_600 + minute * 60}.000100`;

const group = (topLevel: SlackMessage[], threads: Record<string, SlackMessage[]> = {}, joinMinutes = 3) =>
  groupReports({ topLevel, threads: new Map(Object.entries(threads)), me, channel: CHANNEL, workspaceUrl: WORKSPACE, joinMinutes } satisfies GroupInput);

describe("what one report is", () => {
  it("never makes a report of an ignored user's message, nor joins their replies into one", () => {
    const ignore = new Set(["U0TEAM"]);
    const reports = groupReports({
      topLevel: [
        { ts: ts(0), user: "U1", text: "a", reply_count: 2 },
        { ts: ts(1), user: "U0TEAM", text: "¿qué app?" },
        { ts: ts(2), user: "U1", text: "b" },
        { ts: ts(20), user: "U0TEAM", text: "sólo conversando" },
      ],
      threads: new Map([[ts(0), [{ ts: ts(0), user: "U1", text: "a" }, { ts: ts(5), user: "U0TEAM", text: "lo miro" }, { ts: ts(6), user: "U1", text: "gracias" }]]]),
      me,
      channel: CHANNEL,
      workspaceUrl: WORKSPACE,
      joinMinutes: 3,
      ignore,
    });
    // The team member's top-level message opens nothing and, being somebody
    // else speaking, ends U1's run; their thread reply is not in the report
    // and is not the activity it settles from.
    expect(reports.map((report) => [report.author, report.messages.map((message) => message.text)])).toEqual([
      ["U1", ["a", "gracias"]],
      ["U1", ["b"]],
    ]);
    expect(reports[0]!.lastActivity).toBe(ts(6));
  });

  it("joins at the window's edge and not a second past it", () => {
    const reports = group([
      { ts: ts(0), user: "U1", text: "a" },
      { ts: ts(3), user: "U1", text: "b" },
      { ts: `${1_760_961_600 + 6 * 60 + 1}.000100`, user: "U1", text: "c" },
    ]);
    expect(reports.map((report) => report.messages.map((message) => message.text))).toEqual([["a", "b"], ["c"]]);
  });

  it("measures the window from the previous message, so a run can be longer than the window", () => {
    const reports = group([0, 2, 4, 6].map((minute) => ({ ts: ts(minute), user: "U1", text: String(minute) })));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.roots).toHaveLength(4);
  });

  it("skips channel furniture, which also breaks a run", () => {
    const reports = group([
      { ts: ts(0), user: "U1", text: "a" },
      { ts: ts(1), user: "U2", subtype: "channel_join", text: "se unió" },
      { ts: ts(2), user: "U1", text: "b" },
    ]);
    expect(reports.map((report) => report.messages.map((message) => message.text))).toEqual([["a"], ["b"]]);
  });

  it("lets the clerk's own message sit between two of an author's without breaking the run", () => {
    const reports = group([
      { ts: ts(0), user: "U1", text: "a" },
      { ts: ts(1), user: BOT.userId, bot_id: BOT.botId, text: "aviso" },
      { ts: ts(2), user: "U1", text: "b" },
    ]);
    expect(reports.map((report) => report.messages.map((message) => message.text))).toEqual([["a", "b"]]);
  });

  it("does not let a reply broadcast to the channel break an author's run", () => {
    const reports = group([
      { ts: ts(0), user: "U1", text: "a" },
      { ts: ts(1), user: "U1", subtype: "thread_broadcast", thread_ts: ts(0), text: "también al canal" },
      { ts: ts(2), user: "U1", text: "b" },
    ]);
    expect(reports.map((report) => report.messages.map((message) => message.text))).toEqual([["a", "b"]]);
  });

  it("keeps a file share, and counts a thread's newest reply as the report's last activity", () => {
    const reports = group(
      [{ ts: ts(0), user: "U1", subtype: "file_share", text: "", files: [{ permalink: "https://x/f.png" }], reply_count: 1 }],
      { [ts(0)]: [{ ts: ts(0), user: "U1" }, { ts: ts(9), user: "U2", text: "también", thread_ts: ts(0) }] },
    );
    expect(reports[0]!.lastActivity).toBe(ts(9));
    expect(reports[0]!.messages[0]!.files).toEqual(["https://x/f.png"]);
    expect(settled(reports[0]!, (1_760_961_600 + 18 * 60) * 1000, 10)).toBe(false);
    expect(settled(reports[0]!, (1_760_961_600 + 19 * 60) * 1000, 10)).toBe(true);
  });

  it("builds message and thread permalinks the way Slack shows them", () => {
    expect(permalink(WORKSPACE, CHANNEL, "1760961600.000100")).toBe("https://example.slack.com/archives/C0TESTCHAN1/p1760961600000100");
    expect(permalink("https://example.slack.com", CHANNEL, "1760961660.000100", "1760961600.000100")).toBe(
      "https://example.slack.com/archives/C0TESTCHAN1/p1760961660000100?thread_ts=1760961600.000100&cid=C0TESTCHAN1",
    );
  });
});

describe("where the cursor may move", () => {
  const top: SlackMessage[] = [
    { ts: ts(1), user: "U1", text: "a" },
    { ts: ts(2), user: BOT.userId, bot_id: BOT.botId, text: "aviso" },
    { ts: ts(5), user: "U2", text: "b" },
    { ts: ts(9), user: "U3", text: "c" },
  ];
  const reports = group(top);

  it("passes processed reports and furniture, and stops at the first report that is not done", () => {
    const done = new Set([reports[0]!.id, reports[2]!.id]);
    expect(advanceCursor(ts(0), top, reports, (id) => done.has(id))).toBe(ts(2));
  });

  it("goes to the newest message when everything is done, and never backwards", () => {
    expect(advanceCursor(ts(0), top, reports, () => true)).toBe(ts(9));
    expect(advanceCursor(ts(30), top, reports, () => false)).toBe(ts(30));
  });
});
