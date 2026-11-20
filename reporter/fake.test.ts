import { describe, expect, it } from "vitest";

import { NOW, reporterContract, seedIssue, seedOf } from "./contract";
import { boundEvidence, MAX_MESSAGE_CHARS } from "./evidence";
import { createFakeReporter } from "./fake";
import { writeScopes } from "./types";

reporterContract("fake", {
  kind: "fake",
  pageSize: 5,
  pageCap: 3,
  make: (seed) => createFakeReporter(seed, { pageSize: 5, pageCap: 3 }),
});

describe("fake reporter", () => {
  it("names the unknown id in its reason", async () => {
    const read = await createFakeReporter(seedOf([seedIssue("known", 1)])).readEvidence("missing-42");
    expect(read).toEqual({ reachable: false, why: expect.stringContaining("missing-42") });
  });

  it("folds a multi-line outage reason onto one line", async () => {
    const reporter = createFakeReporter({ ...seedOf([]), outage: "502 Bad Gateway\n<html>" });
    expect(await reporter.checkAccess()).toEqual({ reachable: false, why: "502 Bad Gateway <html>" });
  });

  it("is not truncated when the matches fill the cap exactly", async () => {
    const issues = Array.from({ length: 6 }, (_, index) => seedIssue(`p${index}`, index));
    const list = await createFakeReporter(seedOf(issues), { pageSize: 2, pageCap: 3 }).listCandidates({
      since: "2026-01-01T00:00:00Z",
      lookbackHours: 24,
      now: NOW,
    });
    expect(list).toMatchObject({ reachable: true, truncated: false });
  });
});

describe("writeScopes", () => {
  it("names every scope that does not end in :read", () => {
    expect(
      writeScopes(["project:read", "project:write", "event:admin", "org:ci", "project:releases", "event:read"]),
    ).toEqual(["project:write", "event:admin", "org:ci", "project:releases"]);
    expect(writeScopes(["org:read", "event:read"])).toEqual([]);
  });
});

describe("boundEvidence", () => {
  it("leaves a message at the limit uncut", () => {
    const message = "m".repeat(MAX_MESSAGE_CHARS);
    const evidence = boundEvidence({
      issueId: "1",
      release: null,
      environment: null,
      frames: [],
      tags: {},
      breadcrumbs: [{ at: "2026-11-04T00:00:00Z", category: "log", level: "info", message }],
    });
    expect(evidence.breadcrumbs[0]!.message).toBe(message);
  });

  it("clips a frame's enormous file and function names", () => {
    const huge = "f".repeat(MAX_MESSAGE_CHARS * 5);
    const evidence = boundEvidence({
      issueId: "1",
      release: null,
      environment: null,
      frames: [{ file: huge, function: huge, line: 1, inApp: true }],
      tags: {},
      breadcrumbs: [],
    });
    const [frame] = evidence.frames;
    expect(frame!.file.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(frame!.function.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(frame!.function.endsWith("…")).toBe(true);
    expect(frame).toMatchObject({ line: 1, inApp: true });
  });

  it("never cuts a message through a surrogate pair", () => {
    const message = `${"a".repeat(MAX_MESSAGE_CHARS - 2)}😀😀😀`;
    const evidence = boundEvidence({
      issueId: "x",
      release: null,
      environment: null,
      frames: [],
      tags: {},
      breadcrumbs: [{ at: NOW.toISOString(), category: "c", level: "info", message }],
    });
    const cut = evidence.breadcrumbs[0]!.message;
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).toBe(`${"a".repeat(MAX_MESSAGE_CHARS - 2)}…`);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
