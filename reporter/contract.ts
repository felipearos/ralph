/**
 * The behaviour every `Reporter` adapter owes the loops (felipearos/ralph#680),
 * as one suite each adapter's test file runs against its own setup: the
 * in-memory fake, and Sentry over an emulated API (`sentry-emulator.ts`)
 * beside recorded-shape fixtures in its own tests. A new reporter is done
 * when it passes this.
 *
 * Only outcomes are asserted (what a read returns), never which calls an
 * adapter made to get there. The seed builders are exported so an adapter's
 * own tests arrange the same issues the contract does.
 */
import { describe, expect, it } from "vitest";

import { MAX_BREADCRUMBS, MAX_FRAMES, MAX_MESSAGE_CHARS } from "./evidence";
import type { ReporterSeed, SeedEvent, SeedIssue } from "./fake";
import type { Breadcrumb, Candidate, Frame, Reporter, ReporterKind } from "./types";

export type { ReporterSeed, SeedEvent, SeedIssue } from "./fake";

export interface ReporterContractSetup {
  kind: ReporterKind;
  /** Candidates per page the implementation is built with. */
  pageSize: number;
  /** Pages it reads before reporting `truncated`. */
  pageCap: number;
  make(seed: ReporterSeed): Reporter | Promise<Reporter>;
}

/** The fixed clock every contract seed is relative to. */
export const NOW = new Date("2026-11-04T12:00:00Z");

/** An ISO time `hours` before NOW. */
export const hoursAgo = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

/** `count` events at `hours` before NOW, spread over `users` (null: no user on any of them). */
export const seedEvents = (count: number, hours: number, users: (string | null)[] = [null]): SeedEvent[] =>
  Array.from({ length: count }, (_, index) => ({ at: hoursAgo(hours), user: users[index % users.length] ?? null }));

/** An issue last seen `hours` before NOW with one event then, overridable field by field. */
export const seedIssue = (id: string, hours: number, overrides: Partial<SeedIssue> = {}): SeedIssue => ({
  id,
  title: `Error ${id}`,
  culprit: `app/${id}.ts`,
  level: "error",
  status: "unresolved",
  firstSeen: hoursAgo(hours + 24),
  lastSeen: hoursAgo(hours),
  permalink: `https://sentry.example/issues/${id}/`,
  events: seedEvents(1, hours),
  ...overrides,
});

export const READ_ONLY_ACCESS: ReporterSeed["access"] = {
  tokenValid: true,
  projectVisible: true,
  scopes: ["project:read", "event:read", "org:read"],
};

export const seedOf = (issues: SeedIssue[], access: Partial<ReporterSeed["access"]> = {}): ReporterSeed => ({
  issues,
  access: { ...READ_ONLY_ACCESS, ...access },
});

/** A frame numbered `index` in a trace; every fourth one is the project's own code. */
export const seedFrame = (index: number): Frame => ({
  file: `src/file${index}.ts`,
  function: `fn${index}`,
  line: index,
  inApp: index % 4 === 0,
});

/** The `index`-th breadcrumb of a trail, minutes apart so order is checkable. */
export const seedBreadcrumb = (index: number, message = `step ${index}`): Breadcrumb => ({
  at: new Date(NOW.getTime() - 86_400_000 + index * 60_000).toISOString(),
  category: "ui.click",
  level: "info",
  message,
});

/** A 24-hour lookback whose cursor lets every seeded issue through. */
const QUERY = { since: hoursAgo(1000), lookbackHours: 24, now: NOW };

const ids = (issues: Candidate[]): string[] => issues.map((issue) => issue.id);

export function reporterContract(name: string, setup: ReporterContractSetup): void {
  const make = async (seed: ReporterSeed): Promise<Reporter> => setup.make(structuredClone(seed));

  const candidates = async (seed: ReporterSeed, query = QUERY): Promise<Candidate[]> => {
    const list = await (await make(seed)).listCandidates(query);
    if (!list.reachable) throw new Error(`unreachable: ${list.why}`);
    return list.issues;
  };

  describe(`Reporter contract: ${name}`, () => {
    it("names its kind", async () => {
      expect((await make(seedOf([]))).kind).toBe(setup.kind);
    });

    describe("access", () => {
      it("accepts a read-only token and returns its scopes", async () => {
        const check = await (await make(seedOf([]))).checkAccess();
        expect(check).toEqual({ reachable: true, access: "ok", scopes: READ_ONLY_ACCESS.scopes });
      });

      for (const scope of ["project:write", "event:admin"]) {
        it(`refuses a token with ${scope} and names the scope`, async () => {
          const check = await (
            await make(seedOf([], { scopes: [...READ_ONLY_ACCESS.scopes, scope] }))
          ).checkAccess();
          expect(check.reachable).toBe(true);
          if (!check.reachable || check.access !== "refused") throw new Error(`not refused: ${JSON.stringify(check)}`);
          expect(check.why).toContain(scope);
        });
      }

      it("refuses an invalid token", async () => {
        const check = await (await make(seedOf([], { tokenValid: false }))).checkAccess();
        expect(check).toMatchObject({ reachable: true, access: "refused" });
      });

      it("refuses a token that cannot see the project", async () => {
        const check = await (await make(seedOf([], { projectVisible: false }))).checkAccess();
        expect(check).toMatchObject({ reachable: true, access: "refused" });
      });
    });

    describe("candidates", () => {
      it("keeps only issues last seen at or after the cursor", async () => {
        const seed = seedOf([seedIssue("fresh", 2), seedIssue("edge", 5), seedIssue("stale", 10)]);
        expect(ids(await candidates(seed, { ...QUERY, since: hoursAgo(5) }))).toEqual(["fresh", "edge"]);
      });

      it("drops an issue whose events all fall before the lookback", async () => {
        const seed = seedOf([seedIssue("recent", 3), seedIssue("old", 48, { events: seedEvents(4, 48) })]);
        expect(ids(await candidates(seed))).toEqual(["recent"]);
      });

      it("counts events and distinct users inside the lookback only", async () => {
        const seed = seedOf([
          seedIssue("busy", 1, {
            events: [
              ...seedEvents(12, 2, ["ana", "beto", "cata"]),
              ...seedEvents(3, 3, [null]),
              ...seedEvents(5, 30, ["dani", "eli"]),
            ],
          }),
        ]);
        const [busy] = await candidates(seed);
        expect(busy).toMatchObject({ id: "busy", events: 15, users: 3 });
      });

      it("counts 12 events from 3 users and ignores 5 older ones", async () => {
        const seed = seedOf([
          seedIssue("plain", 1, {
            events: [...seedEvents(12, 2, ["ana", "beto", "cata"]), ...seedEvents(5, 30, ["ana"])],
          }),
        ]);
        expect((await candidates(seed))[0]).toMatchObject({ events: 12, users: 3 });
      });

      it("reads statuses, with muted as ignored, and the regressed flag", async () => {
        const seed = seedOf([
          seedIssue("u", 1, { status: "unresolved", regressed: true }),
          seedIssue("r", 2, { status: "resolved" }),
          seedIssue("i", 3, { status: "ignored", regressed: false }),
          seedIssue("m", 4, { status: "muted" }),
        ]);
        const byId = Object.fromEntries((await candidates(seed)).map((issue) => [issue.id, issue]));
        expect(byId.u).toMatchObject({ status: "unresolved", regressed: true });
        expect(byId.r).toMatchObject({ status: "resolved", regressed: false });
        expect(byId.i).toMatchObject({ status: "ignored", regressed: false });
        expect(byId.m).toMatchObject({ status: "ignored" });
      });

      it("returns every field of a candidate, newest first", async () => {
        const seed = seedOf([seedIssue("middle", 5), seedIssue("newest", 1), seedIssue("oldest", 9)]);
        const issues = await candidates(seed);
        expect(ids(issues)).toEqual(["newest", "middle", "oldest"]);
        expect(issues[0]).toEqual({
          id: "newest",
          title: "Error newest",
          culprit: "app/newest.ts",
          level: "error",
          status: "unresolved",
          regressed: false,
          firstSeen: hoursAgo(25),
          lastSeen: hoursAgo(1),
          events: 1,
          users: 0,
          permalink: "https://sentry.example/issues/newest/",
        });
      });
    });

    describe("paging", () => {
      // Minutes apart, so newest-first order is the seeding order.
      const many = (count: number): SeedIssue[] =>
        Array.from({ length: count }, (_, index) => seedIssue(`p${index}`, index / 60));

      it("returns every match across more than one page", async () => {
        const count = Math.min(setup.pageSize * setup.pageCap, setup.pageSize + 1);
        const list = await (await make(seedOf(many(count)))).listCandidates(QUERY);
        expect(list).toMatchObject({ reachable: true, truncated: false });
        if (!list.reachable) return;
        expect(ids(list.issues)).toEqual(many(count).map((issue) => issue.id));
      });

      it("stops at the page cap and says it was truncated", async () => {
        const cap = setup.pageSize * setup.pageCap;
        const list = await (await make(seedOf(many(cap + setup.pageSize)))).listCandidates(QUERY);
        expect(list).toMatchObject({ reachable: true, truncated: true });
        if (!list.reachable) return;
        expect(ids(list.issues)).toEqual(many(cap).map((issue) => issue.id));
      });
    });

    describe("evidence", () => {
      it("returns release, environment, the four tags and in-app frames first, innermost first", async () => {
        const frames: Frame[] = [
          { file: "node_modules/react.js", function: "render", line: 10, inApp: false },
          { file: "src/page.tsx", function: "Page", line: 20, inApp: true },
          { file: "node_modules/lib.js", function: "call", line: null, inApp: false },
          { file: "src/crash.ts", function: "crash", line: 30, inApp: true },
        ];
        const seed = seedOf([
          seedIssue("e1", 1, {
            release: "web@1.2.3",
            environment: "production",
            frames,
            breadcrumbs: [seedBreadcrumb(0), seedBreadcrumb(1)],
            tags: {
              browser: "Chrome 130",
              os: "macOS 15",
              url: "https://app.example/page",
              transaction: "/page",
              "server.name": "web-1",
              level: "error",
            },
          }),
        ]);
        const read = await (await make(seed)).readEvidence("e1");
        if (!read.reachable) throw new Error(`unreachable: ${read.why}`);
        expect(read.evidence).toEqual({
          issueId: "e1",
          release: "web@1.2.3",
          environment: "production",
          frames: [frames[3], frames[1], frames[2], frames[0]],
          framesOmitted: 0,
          tags: { browser: "Chrome 130", os: "macOS 15", url: "https://app.example/page", transaction: "/page" },
          breadcrumbs: [seedBreadcrumb(0), seedBreadcrumb(1)],
          breadcrumbsOmitted: 0,
        });
      });

      it("reads an issue with no release or environment as null", async () => {
        const read = await (await make(seedOf([seedIssue("bare", 1)]))).readEvidence("bare");
        expect(read).toMatchObject({ reachable: true, evidence: { release: null, environment: null } });
      });

      it("bounds a 200-frame trace and 500 breadcrumbs", async () => {
        const long = "x".repeat(MAX_MESSAGE_CHARS * 3);
        const breadcrumbs = Array.from({ length: 500 }, (_, index) =>
          index === 499 ? seedBreadcrumb(index, long) : seedBreadcrumb(index),
        );
        const seed = seedOf([
          seedIssue("big", 1, { frames: Array.from({ length: 200 }, (_, index) => seedFrame(index)), breadcrumbs }),
        ]);
        const read = await (await make(seed)).readEvidence("big");
        if (!read.reachable) throw new Error(`unreachable: ${read.why}`);
        const { evidence } = read;

        expect(evidence.frames).toHaveLength(MAX_FRAMES);
        expect(evidence.framesOmitted).toBe(200 - MAX_FRAMES);
        const firstOther = evidence.frames.findIndex((frame) => !frame.inApp);
        const lastInApp = evidence.frames.map((frame) => frame.inApp).lastIndexOf(true);
        expect(lastInApp).toBeLessThan(firstOther === -1 ? Infinity : firstOther);
        // 50 of 200 are in-app, so all 30 kept are, innermost (highest index) first.
        expect(evidence.frames.map((frame) => frame.line)).toEqual(
          Array.from({ length: MAX_FRAMES }, (_, index) => 196 - index * 4),
        );

        expect(evidence.breadcrumbs).toHaveLength(MAX_BREADCRUMBS);
        expect(evidence.breadcrumbsOmitted).toBe(500 - MAX_BREADCRUMBS);
        expect(evidence.breadcrumbs.slice(0, -1)).toEqual(
          Array.from({ length: MAX_BREADCRUMBS - 1 }, (_, index) => seedBreadcrumb(500 - MAX_BREADCRUMBS + index)),
        );
        const cut = evidence.breadcrumbs.at(-1)!;
        expect(cut.at).toBe(seedBreadcrumb(499).at);
        expect(cut.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
        expect(cut.message.endsWith("…")).toBe(true);
        expect(long.startsWith(cut.message.slice(0, -1))).toBe(true);
      });

      it("keeps in-app frames ahead of the others when both are kept", async () => {
        // 40 frames, every fourth in-app: 10 in-app then 20 others survive the cut.
        const seed = seedOf([
          seedIssue("mix", 1, { frames: Array.from({ length: 40 }, (_, index) => seedFrame(index)) }),
        ]);
        const read = await (await make(seed)).readEvidence("mix");
        if (!read.reachable) throw new Error(`unreachable: ${read.why}`);
        const flags = read.evidence.frames.map((frame) => frame.inApp);
        expect(flags).toEqual([...Array(10).fill(true), ...Array(MAX_FRAMES - 10).fill(false)]);
        expect(read.evidence.frames[0]!.line).toBe(36);
        expect(read.evidence.frames[10]!.line).toBe(39);
        expect(read.evidence.framesOmitted).toBe(10);
      });

      it("cuts a long tag value", async () => {
        const seed = seedOf([seedIssue("tag", 1, { tags: { url: `https://app.example/${"a".repeat(500)}` } })]);
        const read = await (await make(seed)).readEvidence("tag");
        if (!read.reachable) throw new Error(`unreachable: ${read.why}`);
        expect(read.evidence.tags.url!.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
      });
    });

    describe("unreachable", () => {
      const expectOneLine = (result: { reachable: boolean; why?: string }): void => {
        expect(result.reachable).toBe(false);
        expect(result.why).toBeTruthy();
        expect(result.why!.trim()).not.toBe("");
        expect(result.why).not.toMatch(/\n/);
      };

      it("resolves every call to unreachable during an outage", async () => {
        const reporter = await make({ ...seedOf([seedIssue("x", 1)]), outage: "connection refused" });
        expectOneLine(await reporter.checkAccess());
        expectOneLine(await reporter.listCandidates(QUERY));
        expectOneLine(await reporter.readEvidence("x"));
      });

      it("reads evidence for an unknown id as unreachable with a reason", async () => {
        const read = await (await make(seedOf([seedIssue("known", 1)]))).readEvidence("missing-42");
        expectOneLine(read);
      });
    });
  });
}
