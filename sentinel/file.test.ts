// @vitest-environment node
/**
 * What the sentinel files (felipearos/ralph#682): a ticket a person must read
 * first, with markers that find it again so one reporter issue never gets two
 * tickets, and a templated draft that says plainly it was not diagnosed.
 */
import { describe, expect, it } from "vitest";

import type { Candidate, Evidence, Frame } from "../reporter/types";
import { createFakeTracker } from "../tracker/fake";
import type { Tracker } from "../tracker/types";
import { fileTicket, recurrenceComment, SENTINEL_LABEL, searchToken, sentinelMarker, templatedDraft, ticketBody } from "./file";
import { emptyStore, recordCandidate, type IssueRecord } from "./store";

const NOW = new Date("2026-11-04T10:00:00.000Z");

const candidate = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  title: "TypeError: x is undefined",
  culprit: "app/page.tsx",
  level: "error",
  status: "unresolved",
  regressed: true,
  firstSeen: "2026-11-03T10:00:00.000Z",
  lastSeen: "2026-11-04T09:00:00.000Z",
  events: 37,
  users: 4,
  permalink: `https://sentry.example/issues/${id}`,
  ...over,
});

const frame = (n: number, inApp: boolean): Frame => ({ file: `src/f${n}.ts`, function: `fn${n}`, line: n, inApp });

const evidence = (id: string, frames: Frame[] = []): Evidence => ({
  issueId: id,
  release: "abc123",
  environment: "production",
  frames,
  framesOmitted: 0,
  tags: {},
  breadcrumbs: [],
  breadcrumbsOmitted: 0,
});

const recordOf = (id: string, over: Partial<Candidate> = {}, withEvidence: Evidence | null = evidence(id)): IssueRecord => {
  const record = recordCandidate(emptyStore(), "sentry", candidate(id, over), "file", NOW);
  record.evidence = withEvidence;
  return record;
};

const draft = { title: "Fix the TypeError on the page", body: "  The page reads x before it loads.\n", at: NOW.toISOString() };

describe("markers", () => {
  it("writes the spec's marker", () => {
    expect(sentinelMarker("sentry", "12")).toBe("<!-- ralph-sentinel: sentry:12 -->");
  });

  it("makes a one-word token that is not a prefix of a longer id's", () => {
    expect(searchToken("sentry", "12")).toMatch(/^[a-z0-9]+$/);
    expect(searchToken("Sentry", "AB-12")).toBe("ralphsentinelsentryab12end");
    expect(searchToken("sentry", "123")).not.toContain(searchToken("sentry", "12"));
  });

  it("keeps cycle 0 as it was and gives a later cycle its own token", () => {
    expect(searchToken("sentry", "12", 0)).toBe("ralphsentinelsentry12end");
    expect(sentinelMarker("sentry", "12", 0)).toBe("<!-- ralph-sentinel: sentry:12 -->");
    expect(searchToken("sentry", "12", 1)).toBe("ralphsentinelsentry12r1end");
    expect(sentinelMarker("sentry", "12", 1)).toBe("<!-- ralph-sentinel: sentry:12 cycle 1 -->");
    const tokens = [searchToken("sentry", "12"), searchToken("sentry", "12", 1), searchToken("sentry", "12", 10), searchToken("sentry", "121"), searchToken("sentry", "12", 2)];
    for (const a of tokens) {
      for (const b of tokens) if (a !== b) expect(b).not.toContain(a);
    }
  });
});

describe("ticketBody", () => {
  it("appends the link and both markers to the trimmed draft", () => {
    const body = ticketBody(recordOf("12"), draft.body);
    expect(body.startsWith("The page reads x before it loads.\n\nSentry: https://sentry.example/issues/12\n")).toBe(true);
    expect(body).toContain(sentinelMarker("sentry", "12"));
    expect(body).toContain(`<!-- ${searchToken("sentry", "12")} -->`);
  });

  it("omits the link line when the reporter gave none", () => {
    const body = ticketBody(recordOf("12", { permalink: "" }), draft.body);
    expect(body).not.toContain("Sentry:");
    expect(body).toContain(sentinelMarker("sentry", "12"));
  });
});

describe("a regression's ticket", () => {
  const regressed = (id: string): IssueRecord => Object.assign(recordOf(id), { cycle: 1, regressedAfter: "#7" });

  it("leads a regression's body in the project's language", () => {
    expect(ticketBody(regressed("12"), draft.body, "es").startsWith("Regresión después de #7.")).toBe(true);
  });

  it("starts with the closed ticket and carries the cycle's markers", () => {
    const body = ticketBody(regressed("12"), draft.body);
    expect(body.split("\n").slice(0, 3)).toEqual(["Regressed after #7.", "", "The page reads x before it loads."]);
    expect(body).toContain(sentinelMarker("sentry", "12", 1));
    expect(body).toContain(`<!-- ${searchToken("sentry", "12", 1)} -->`);
    expect(body).not.toContain(searchToken("sentry", "12"));
  });

  it("files a new ticket rather than adopting the closed cycle's", async () => {
    const tracker = createFakeTracker();
    const first = await fileTicket(tracker, recordOf("12"), draft);
    const second = await fileTicket(tracker, regressed("12"), draft);
    expect(second.kind).toBe("created");
    expect(second.number).not.toBe(first.number);
    expect(await fileTicket(tracker, regressed("12"), draft)).toEqual({ kind: "adopted", number: second.number });
  });
});

describe("recurrenceComment", () => {
  const now = { events: 25, users: 7, lastSeen: "2026-11-04T09:30:00.000Z", release: "abc123", baseline: 12 };

  it("states the counts in English, with the link", () => {
    const body = recurrenceComment(recordOf("12"), now, "en");
    expect(body).toContain("**The sentinel saw this issue again.** 25 events and 7 users inside the lookback (12 events when last counted)");
    expect(body).toContain("last seen 2026-11-04T09:30:00.000Z; release abc123.");
    expect(body).toContain("Sentry: https://sentry.example/issues/12");
  });

  it("writes Spanish, an unknown release, and no link when there is none", () => {
    const body = recurrenceComment(recordOf("12", { permalink: "" }), { ...now, release: null }, "es");
    expect(body).toContain("25 eventos y 7 usuarios");
    expect(body).toContain("(12 eventos");
    expect(body).toContain("release desconocido");
    expect(body).not.toContain("Sentry:");
  });
});

describe("fileTicket", () => {
  it("creates one ready-for-human ticket and adopts it on a second filing", async () => {
    const tracker = createFakeTracker();
    const record = recordOf("12");
    const first = await fileTicket(tracker, record, draft);
    expect(first.kind).toBe("created");
    expect(tracker.issues.size).toBe(1);
    const issue = tracker.issues.get(first.number)!;
    expect(issue.title).toBe(draft.title);
    expect(issue.labels).toContain(SENTINEL_LABEL);
    expect(issue.labels).not.toContain("ready-for-agent");
    expect(issue.body).toContain(sentinelMarker("sentry", "12"));
    expect(issue.body).toContain(searchToken("sentry", "12"));
    expect(issue.body).toContain("https://sentry.example/issues/12");

    expect(await fileTicket(tracker, record, draft)).toEqual({ kind: "adopted", number: first.number });
    expect(tracker.issues.size).toBe(1);
  });

  it("does not adopt issue 12's ticket for issue 123", async () => {
    const tracker = createFakeTracker();
    await fileTicket(tracker, recordOf("12"), draft);
    expect((await fileTicket(tracker, recordOf("123"), draft)).kind).toBe("created");
    expect(tracker.issues.size).toBe(2);
  });

  it("refuses to file when the label is missing and creates nothing", async () => {
    const fake = createFakeTracker();
    const tracker: Tracker = { ...fake, ensureLabels: async (labels) => ({ created: [], missing: [...labels] }) };
    await expect(fileTicket(tracker, recordOf("12"), draft)).rejects.toThrow(/ready-for-human/);
    expect(fake.issues.size).toBe(0);
  });
});

describe("templatedDraft", () => {
  const frames = [...Array.from({ length: 12 }, (_, n) => frame(n + 100, false)), ...Array.from({ length: 10 }, (_, n) => frame(n, true))];

  it("says it was not diagnosed, puts in-app frames first and caps them, in English", () => {
    const made = templatedDraft(recordOf("12", {}, evidence("12", frames)), "en", NOW);
    expect(made.title).toBe("TypeError: x is undefined — app/page.tsx");
    expect(made.at).toBe(NOW.toISOString());
    expect(made.body.split("\n")[0]).toMatch(/Not diagnosed.*failed on this issue twice.*nobody has read the code/);
    expect(made.body).toContain("37 events and 4 users");
    expect(made.body).toContain("level error, regressed");
    expect(made.body).toContain("abc123");
    expect(made.body).toContain("production");
    expect(made.body).toContain("https://sentry.example/issues/12");
    const frameLines = made.body.split("\n").filter((line) => /^src\/f\d+\.ts/.test(line));
    expect(frameLines).toHaveLength(15);
    expect(frameLines[0]).toBe("src/f0.ts:0 fn0");
    expect(frameLines.slice(0, 10).every((line) => /^src\/f\d\.ts/.test(line))).toBe(true);
    expect(made.body).toContain("7 more frames");
  });

  it("writes Spanish and handles no stored evidence", () => {
    const made = templatedDraft(recordOf("12", { culprit: "" }, null), "es", NOW);
    expect(made.title).toBe("TypeError: x is undefined");
    expect(made.body).toMatch(/Sin diagnóstico.*falló dos veces/);
    expect(made.body).toContain("No hay evidencia guardada");
    expect(made.body).toContain("37 eventos y 4 usuarios");
  });

  it("keeps the title to one line of at most 200 characters", () => {
    const made = templatedDraft(recordOf("12", { title: `Error\n${"x".repeat(300)}` }), "en", NOW);
    expect(made.title).not.toContain("\n");
    expect(made.title.length).toBeLessThanOrEqual(200);
    expect(made.title.endsWith("…")).toBe(true);
  });
});
