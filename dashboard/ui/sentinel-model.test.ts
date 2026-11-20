/**
 * The Sentinel panel's decisions (felipearos/ralph#685).
 *
 * Rows are full literals rather than casts, as in `following-model.test.ts`:
 * a cast would let a field added to the contract later reach this panel as
 * `undefined` with the suite still green.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { SentinelIssueRow, SentinelPanelView, SentinelRules } from "../contracts";
import { setTrackerLinks } from "./issue-link";
import { sentinelPanel } from "./sentinel-model";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const REPO = "https://github.com/acme/app";

const RULES: SentinelRules = { enabled: true, lookbackHours: 24, minEvents: 10, minUsers: 2, maxPerDay: 5, mode: "file" };

const issue = (id: string, extra: Partial<SentinelIssueRow> = {}): SentinelIssueRow => ({
  key: `sentry:${id}`,
  reporter: "sentry",
  id,
  title: `TypeError in ${id}`,
  permalink: `https://sentry.io/issues/${id}/`,
  state: "observed",
  events: 12,
  users: 3,
  attempts: 0,
  ticket: null,
  ticketNumber: null,
  mode: "file",
  draftTitle: null,
  observedAt: "2026-11-04T09:00:00.000Z",
  updatedAt: "2026-11-04T09:00:00.000Z",
  cycle: 0,
  regressedAfter: null,
  ...extra,
});

const view = (issues: SentinelIssueRow[], extra: Partial<SentinelPanelView> = {}): SentinelPanelView => ({
  rostered: true,
  rules: RULES,
  issues: { version: 1, issues, today: { day: "2026-11-04", filed: 0, alerted: false } },
  problem: null,
  ...extra,
});

afterEach(() => setTrackerLinks(null));

describe("sentinelPanel", () => {
  it("draws nothing for a project with no sentinel loop", () => {
    expect(sentinelPanel({ rostered: false, rules: null, issues: null, problem: null }, NOW, REPO)).toBeNull();
  });

  it("warns, rather than vanishing, when the config could not say whether there is a sentinel", () => {
    const panel = sentinelPanel({ rostered: false, rules: null, issues: null, problem: "cannot read the project config: exit 1" }, NOW, REPO);
    expect(panel?.problem).toBe("The dashboard cannot tell whether this project has a sentinel: cannot read the project config: exit 1");
    expect(panel?.cap).toBeNull();
  });

  it("groups each of the four states, filed first and observed last", () => {
    const panel = sentinelPanel(
      view([
        issue("1", { state: "observed" }),
        issue("2", { state: "failed", attempts: 2 }),
        issue("3", { state: "filed", ticket: "#40", ticketNumber: 40 }),
        issue("4", { state: "drafted", draftTitle: "Fix it" }),
      ]),
      NOW,
      REPO,
    );
    expect(panel?.groups.map((group) => [group.label, group.rows.map((row) => row.key)])).toEqual([
      ["Filed", ["sentry:3"]],
      ["Drafted", ["sentry:4"]],
      ["Failed to file", ["sentry:2"]],
      ["Observed (over the bar, not drafted yet)", ["sentry:1"]],
    ]);
    expect(panel?.empty).toBeNull();
    expect(panel?.problem).toBeNull();
  });

  it("draws a row's title, counts, attempts, regression and age", () => {
    const panel = sentinelPanel(
      view([issue("2", { state: "failed", attempts: 2, cycle: 1, regressedAfter: "#31", updatedAt: "2026-11-04T09:00:00.000Z" })]),
      NOW,
      REPO,
    );
    const row = panel?.groups.find((group) => group.state === "failed")?.rows[0];
    expect(row).toMatchObject({
      title: "TypeError in 2",
      counts: "12 events · 3 users",
      attempts: "2 attempts to file",
      regressed: "regressed after #31",
      updated: "updated 3h ago",
    });
  });

  it("spells one event, one user and one attempt in the singular, and no attempts as none", () => {
    const panel = sentinelPanel(
      view([issue("1", { events: 1, users: 1, attempts: 1 }), issue("2", { attempts: 0, updatedAt: "not a time" })]),
      NOW,
      REPO,
    );
    const [one, two] = panel?.groups.find((group) => group.state === "observed")?.rows ?? [];
    expect(one?.counts).toBe("1 event · 1 user");
    expect(one?.attempts).toBe("1 attempt to file");
    expect(two?.attempts).toBeNull();
    expect(two?.regressed).toBeNull();
    expect(two?.updated).toBe("updated at an unknown time");
  });

  it("links the Sentry issue and the filed ticket", () => {
    const panel = sentinelPanel(
      view([
        issue("3", { state: "filed", ticket: "#40", ticketNumber: 40 }),
        issue("5", { state: "filed", ticket: "https://linear.app/acme/issue/AND-7", ticketNumber: null, permalink: null }),
        issue("6", { state: "observed" }),
      ]),
      NOW,
      REPO,
    );
    const filed = panel?.groups.find((group) => group.state === "filed")?.rows ?? [];
    expect(filed[0]?.sentryUrl).toBe("https://sentry.io/issues/3/");
    expect(filed[0]?.ticket).toEqual({ label: "#40", href: `${REPO}/issues/40` });
    expect(filed[1]?.sentryUrl).toBeNull();
    expect(filed[1]?.ticket).toEqual({ label: "https://linear.app/acme/issue/AND-7", href: "https://linear.app/acme/issue/AND-7" });
    expect(panel?.groups.find((group) => group.state === "observed")?.rows[0]?.ticket).toBeNull();
  });

  it("links a ticket through the project's tracker, and not at all where it has no link", () => {
    setTrackerLinks({ kind: "linear", prefix: "AND-", link: null });
    const panel = sentinelPanel(view([issue("3", { state: "filed", ticket: "AND-40", ticketNumber: 40 })]), NOW, REPO);
    expect(panel?.groups[0]?.rows[0]?.ticket).toEqual({ label: "AND-40", href: null });
  });

  it("lists what observe mode would have filed, and not a file-mode draft", () => {
    const panel = sentinelPanel(
      view(
        [
          issue("1", { state: "drafted", mode: "observe", draftTitle: "Checkout crashes on submit" }),
          issue("2", { state: "drafted", mode: "file", draftTitle: "Already on its way" }),
          issue("3", { state: "observed", mode: "observe", draftTitle: null }),
        ],
        { rules: { ...RULES, mode: "observe" } },
      ),
      NOW,
      REPO,
    );
    expect(panel?.headline).toBe("Observe mode: nothing is filed");
    expect(panel?.wouldHaveFiled).toEqual([
      { key: "sentry:1", text: "would have filed: Checkout crashes on submit", sentryUrl: "https://sentry.io/issues/1/" },
    ]);
  });

  it("names no observe headline in file mode", () => {
    expect(sentinelPanel(view([]), NOW, REPO)?.headline).toBeNull();
  });

  it("leads with Off when the config switched the sentinel off, in either mode (#789)", () => {
    expect(sentinelPanel(view([], { rules: { ...RULES, enabled: false } }), NOW, REPO)?.headline).toBe("Off: disabled in config");
    expect(sentinelPanel(view([], { rules: { ...RULES, mode: "observe", enabled: false } }), NOW, REPO)?.headline).toBe("Off: disabled in config");
  });

  it("shows today's cap, and says when the cap alert went out", () => {
    const quiet = sentinelPanel(view([], { issues: { version: 1, issues: [], today: { day: "2026-11-04", filed: 2, alerted: false } } }), NOW, REPO);
    expect(quiet?.cap).toBe("2 of 5 filed today");
    expect(quiet?.capAlert).toBeNull();
    const full = sentinelPanel(view([], { issues: { version: 1, issues: [], today: { day: "2026-11-04", filed: 5, alerted: true } } }), NOW, REPO);
    expect(full?.cap).toBe("5 of 5 filed today");
    expect(full?.capAlert).toBe("cap reached, alert sent");
  });

  it("draws no cap line with no rules", () => {
    const panel = sentinelPanel(view([], { rules: null }), NOW, REPO);
    expect(panel?.cap).toBeNull();
    expect(panel?.capAlert).toBeNull();
    expect(panel?.headline).toBeNull();
  });

  it("says why the store could not be read, and still draws the rules", () => {
    const panel = sentinelPanel(view([], { issues: null, problem: "issues.ts exited 1", rules: { ...RULES, mode: "observe" } }), NOW, REPO);
    expect(panel?.problem).toBe("The sentinel's issue store could not be read: issues.ts exited 1");
    expect(panel?.headline).toBe("Observe mode: nothing is filed");
    expect(panel?.cap).toBe("0 of 5 filed today");
    expect(panel?.groups).toEqual([]);
    expect(panel?.empty).toBeNull();
  });

  it("says nothing has been seen for an empty store, rather than drawing an empty card", () => {
    const panel = sentinelPanel(view([]), NOW, REPO);
    expect(panel?.empty).toBe("Nothing seen yet");
    expect(panel?.problem).toBeNull();
    expect(panel?.wouldHaveFiled).toEqual([]);
  });
});
