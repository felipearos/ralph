// @vitest-environment node
/**
 * Which merged PRs the verifier watches (felipearos/ralph#563): each skip rule
 * on its own, and the ticket a PR closes on GitHub and on a keyed tracker.
 */
import { describe, expect, it } from "vitest";

import type { RosterEntry, TrackerConfig } from "../project-config";
import type { Gh } from "./deploys";
import { VERIFIER_REVERT_MARKER, listMerged, qualify, ticketOf, type MergedPr, type QualifyContext } from "./merged";

const NOW = new Date("2026-10-29T12:00:00Z");
const GITHUB: TrackerConfig = { kind: "github" };
const LINEAR: TrackerConfig = {
  kind: "linear", team: "OA", workspace: "example", scopeLabel: null, states: { claimed: "In Progress", done: "Done" },
};
const ROSTER: RosterEntry[] = [
  { name: "ralph", role: "coder" },
  { name: "medi", role: "pr-medic" },
];

const pr = (over: Partial<MergedPr> = {}): MergedPr => ({
  number: 12,
  title: "verifier: open watches (#184)",
  body: "Closes #184\n\nWhy.",
  headRefName: "felipe/184-watches",
  mergeCommit: "abc123",
  mergedAt: "2026-10-29T10:00:00Z",
  labels: [],
  closingIssues: [],
  ...over,
});

const ctx = (over: Partial<QualifyContext> = {}): QualifyContext => ({
  rules: { windowHours: 24, follow: { loopPrs: true, humanPrs: true } },
  tracker: GITHUB,
  roster: ROSTER,
  now: NOW,
  ...over,
});

const why = (p: MergedPr, c = ctx()): string | null => {
  const result = qualify(p, c);
  return result.kind === "skipped" ? result.why : null;
};

describe("qualify", () => {
  it("passes a recent human PR that closes a ticket, with what the watch needs", () => {
    expect(qualify(pr(), ctx())).toEqual({
      kind: "qualified",
      candidate: { pr: 12, ticket: 184, ticketRef: "#184", mergeCommit: "abc123", mergedAt: "2026-10-29T10:00:00Z" },
    });
  });

  it("skips a PR that closes no ticket", () => {
    expect(why(pr({ body: "Refs #184" }))).toBe("closes no tracker ticket");
  });

  it("skips a journal commit", () => {
    expect(why(pr({ title: "chore(ralph): journal software factory #562" }))).toBe("is a journal or learnings commit");
  });

  it("skips a learnings commit", () => {
    expect(why(pr({ title: "chore(rafa): learning loggd #12" }))).toBe("is a journal or learnings commit");
  });

  it("skips a ci-doctor PR by its marker", () => {
    expect(why(pr({ body: "Closes #184\n<!-- ci-doctor revert abc -->" }))).toBe("is a ci-doctor PR");
  });

  it("skips a ci-doctor PR by its ci-health label", () => {
    expect(why(pr({ labels: ["ci-health"] }))).toBe("is a ci-doctor PR");
  });

  it("skips a pr-medic PR by its marker", () => {
    expect(why(pr({ body: "Closes #184\n<!-- pr-medic: adopted -->" }))).toBe("is a pr-medic PR");
  });

  it("skips a pr-medic PR by a roster pr-medic's branch", () => {
    expect(why(pr({ headRefName: "medi/184-rescue" }))).toBe("is a pr-medic PR");
    // A coder's branch is not a medic's.
    expect(why(pr({ headRefName: "ralph/184-watches" }))).toBeNull();
  });

  it("skips a verifier revert", () => {
    expect(why(pr({ body: `Closes #184\n${VERIFIER_REVERT_MARKER} of #11 -->` }))).toBe("is a verifier revert");
  });

  it("skips a loop PR when loopPrs is false, naming the setting", () => {
    const loop = pr({ body: "Closes #184\n\n🤖 ralph loop, run 7" });
    expect(why(loop, ctx({ rules: { windowHours: 24, follow: { loopPrs: false, humanPrs: true } } }))).toBe(
      "is a ralph loop PR and verifier.follow.loopPrs is false",
    );
    expect(why(pr(), ctx({ rules: { windowHours: 24, follow: { loopPrs: false, humanPrs: true } } }))).toBeNull();
  });

  it("skips a human PR when humanPrs is false, naming the setting", () => {
    const off = ctx({ rules: { windowHours: 24, follow: { loopPrs: true, humanPrs: false } } });
    expect(why(pr(), off)).toBe("is a human PR and verifier.follow.humanPrs is false");
    // A provenance line for a loop not on the roster is still a human PR.
    expect(why(pr({ body: "Closes #184\n🤖 stranger loop" }), off)).toBe("is a human PR and verifier.follow.humanPrs is false");
    expect(why(pr({ body: "Closes #184\n🤖 ralph loop" }), off)).toBeNull();
  });

  it("skips a merge older than the window", () => {
    expect(why(pr({ mergedAt: "2026-10-28T11:59:00Z" }))).toBe("merged more than 24h ago");
    expect(why(pr({ mergedAt: "2026-10-28T12:01:00Z" }))).toBeNull();
  });

  it("skips a PR with no merge commit", () => {
    expect(why(pr({ mergeCommit: null }))).toBe("has no merge commit or merge time");
  });
});

describe("ticketOf", () => {
  it("takes the first linked issue on GitHub", () => {
    expect(ticketOf({ body: "Closes #9", closingIssues: [184, 190] }, GITHUB)).toEqual({ ticket: 184, ticketRef: "#184" });
  });

  it("reads Closes/Fixes/Resolves #n from the body on GitHub, case-insensitively", () => {
    expect(ticketOf({ body: "Why.\n\ncloses #7", closingIssues: [] }, GITHUB)).toEqual({ ticket: 7, ticketRef: "#7" });
    expect(ticketOf({ body: "Fixes #8", closingIssues: [] }, GITHUB)?.ticket).toBe(8);
    expect(ticketOf({ body: "RESOLVES #9", closingIssues: [] }, GITHUB)?.ticket).toBe(9);
  });

  it("reads the pr-ref Ticket line on a keyed tracker", () => {
    const body = "Why.\n\nTicket: OA-410 https://linear.app/example/issue/OA-410";
    expect(ticketOf({ body, closingIssues: [] }, LINEAR)).toEqual({ ticket: 410, ticketRef: "OA-410" });
  });

  it("never reads #n as a ticket on a keyed tracker", () => {
    expect(ticketOf({ body: "Closes #5", closingIssues: [5] }, LINEAR)).toBeNull();
    expect(ticketOf({ body: "Ticket: XY-4 https://x", closingIssues: [] }, LINEAR)).toBeNull();
  });

  it("uses the Jira project and the local key", () => {
    const jira: TrackerConfig = { kind: "jira", site: "s", project: "OAI", scopeLabel: null, states: { claimed: "a", done: "b" } };
    const local: TrackerConfig = { kind: "local", key: "LOC", file: "f", scopeLabel: null, states: { claimed: "a", done: "b" } };
    expect(ticketOf({ body: "Ticket: OAI-29 https://x", closingIssues: [] }, jira)?.ticketRef).toBe("OAI-29");
    expect(ticketOf({ body: "Ticket: LOC-3 local", closingIssues: [] }, local)?.ticketRef).toBe("LOC-3");
  });
});

describe("listMerged", () => {
  it("parses gh's merged list", async () => {
    const calls: string[][] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      return {
        ok: true,
        stderr: "",
        stdout: JSON.stringify([{
          number: 3, title: "t", body: "b", headRefName: "h", mergeCommit: { oid: "sha" }, mergedAt: "2026-10-29T10:00:00Z",
          labels: [{ name: "x" }], closingIssuesReferences: [{ number: 4 }],
        }]),
      };
    };
    expect(await listMerged(gh, "main", new Date("2026-10-28T10:00:00.000Z"))).toEqual({
      ok: true,
      prs: [{ number: 3, title: "t", body: "b", headRefName: "h", mergeCommit: "sha", mergedAt: "2026-10-29T10:00:00Z", labels: ["x"], closingIssues: [4] }],
    });
    expect(calls[0]?.slice(0, 8)).toEqual(["pr", "list", "--state", "merged", "--base", "main", "--search", "merged:>=2026-10-28T10:00:00Z sort:updated-desc"]);
  });

  it("reports a failed or unparsable read instead of throwing", async () => {
    expect(await listMerged(async () => ({ ok: false, stdout: "", stderr: "HTTP 502" }), "main", new Date())).toEqual({ ok: false, why: "gh pr list failed: HTTP 502" });
    expect(await listMerged(async () => ({ ok: true, stdout: "nope", stderr: "" }), "main", new Date())).toEqual({ ok: false, why: "gh pr list did not answer JSON" });
    expect((await listMerged(async () => { throw new Error("spawn gh ENOENT"); }, "main", new Date())).ok).toBe(false);
  });
});
