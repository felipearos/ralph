// @vitest-environment node
/**
 * `pr-medic/known-red.ts`: when a red operator PR is the doctor's rather than
 * the medic's. The narrowness is the contract — a false "known" costs the
 * operator the medic on that head commit — so most of these are refusals.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Build, Digest } from "../bk-log";
import { emptyStore, withStore, type Case, type CiHealthStore } from "../ci-doctor/store";
import { confirmedFlake, infraOnBuild, judgeBuild, readKnownRed, type BuildkiteReads, type KnownDeps } from "./known-red";

const SHA = "a".repeat(40);
const HEAD = { pr: 2197, sha: SHA, branch: "felipearosr/x" };
const TEST = "src/a.test.ts > flaps";

const kase = (over: Partial<Case> = {}): Case => ({
  kind: "flake",
  state: "confirmed",
  evidence: [{ build: 4000, branch: "main", commit: "b".repeat(40), kind: "timeout", line: "FAIL" }],
  cost72h: { redBuilds: 3, mainReds: 1, dequeues: 0 },
  issue: null,
  pr: null,
  fixAttempts: 0,
  unparks: {},
  ...over,
});

const storeWith = (cases: Record<string, Case>): CiHealthStore => ({ ...emptyStore(), cases });

const digest = (titles: string[]): Digest => ({
  command: "bun run test",
  failures: titles.map((title) => ({ title, detail: [] })),
  summary: [],
  exit: [],
  files: ["src/a.test.ts"],
  tail: [],
  timeoutsOnly: true,
});

const build: Build = { number: 4821, state: "failed", branch: HEAD.branch, commit: SHA };

describe("judgeBuild", () => {
  it("calls a build red only on confirmed flakes known, with every failed job as the target", () => {
    const verdict = judgeBuild(
      HEAD,
      build,
      [
        { id: "j1", digest: digest([`FAIL ${TEST}`]) },
        { id: "j2", digest: digest([`FAIL ${TEST}`]) },
      ],
      storeWith({ [`flake:${TEST}`]: kase() }),
      "loggd",
    );
    expect(verdict).toMatchObject({
      kind: "known",
      target: { pr: 2197, sha: SHA, build: 4821, jobs: ["j1", "j2"] },
    });
    expect(verdict.why).toContain("1 confirmed flake");
  });

  it("does not count a candidate, an unknown test, or one the store has as this branch's", () => {
    const one = [{ id: "j1", digest: digest([`FAIL ${TEST}`]) }];
    expect(judgeBuild(HEAD, build, one, storeWith({ [`flake:${TEST}`]: kase({ state: "candidate" }) }), null).kind).toBe(
      "unknown",
    );
    expect(judgeBuild(HEAD, build, one, storeWith({}), null).kind).toBe("unknown");
    const both = storeWith({
      [`flake:${TEST}`]: kase(),
      [`pr-specific:${HEAD.branch}:${TEST}`]: kase({ kind: "pr-specific" }),
    });
    expect(judgeBuild(HEAD, build, one, both, null).kind).toBe("unknown");
  });

  it("one unknown failure among known ones makes the whole build the medic's", () => {
    const verdict = judgeBuild(
      HEAD,
      build,
      [{ id: "j1", digest: digest([`FAIL ${TEST}`, "FAIL src/b.test.ts > breaks"]) }],
      storeWith({ [`flake:${TEST}`]: kase() }),
      null,
    );
    expect(verdict).toMatchObject({ kind: "unknown", why: "src/b.test.ts > breaks is not a known flake" });
  });

  it("knows a job with no test failure only by an open infra incident on THIS build or head", () => {
    const jobs = [{ id: "boot", digest: digest([]) }];
    const infra = (evidenceBuild: number, over: Partial<Case> = {}): CiHealthStore =>
      storeWith({
        "infra:agent-lost": kase({
          kind: "infra",
          evidence: [{ build: evidenceBuild, branch: "x", commit: "c".repeat(40), kind: "bootstrap", line: "agent lost" }],
          ...over,
        }),
      });
    expect(judgeBuild(HEAD, build, jobs, infra(4821), null)).toMatchObject({ kind: "known" });
    // Open somewhere else is what `bk-log.ts` prints, and not enough to decide on.
    expect(judgeBuild(HEAD, build, jobs, infra(4000), null).kind).toBe("unknown");
    expect(judgeBuild(HEAD, build, jobs, infra(4821, { state: "fixed" }), null).kind).toBe("unknown");
    expect(
      judgeBuild(HEAD, build, jobs, infra(4821, { rejectedAt: { build: 4821, at: "", reason: "not infra" } }), null).kind,
    ).toBe("unknown");
    expect(infraOnBuild(infra(1, { evidence: [{ build: 1, branch: "x", commit: SHA, kind: "bootstrap", line: "" }] }), 4821, SHA)).toBe(
      "infra:agent-lost",
    );
  });

  it("waits on a job whose log could not be read, and has nothing to say about no failed job", () => {
    expect(judgeBuild(HEAD, build, [{ id: "j1", digest: null }], storeWith({}), null).kind).toBe("wait");
    expect(judgeBuild(HEAD, build, [], storeWith({}), null).kind).toBe("unknown");
  });

  it("reads the confirmed-flake verdict off the `known:` line's own words", () => {
    expect(confirmedFlake(["loggd #12 — confirmed flake (timeout, 3 reds/72h)"])).toBe(true);
    expect(confirmedFlake(["flake candidate (timeout) — not confirmed yet"])).toBe(false);
    expect(confirmedFlake(["confirmed flake", "red only on this branch — likely the diff"])).toBe(false);
  });
});

describe("readKnownRed", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const storePath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "known-red-"));
    dirs.push(dir);
    return join(dir, "ci-health.json");
  };
  const ROLLUP = [
    {
      __typename: "StatusContext",
      context: "buildkite/loggd",
      state: "FAILURE",
      targetUrl: "https://buildkite.com/loggd/loggd/builds/4821",
    },
  ];
  const reads = (over: Partial<BuildkiteReads> = {}): BuildkiteReads & { pipeline: string } => ({
    pipeline: "loggd",
    org: async () => "loggd",
    build: async () => ({ ...build, jobs: [{ id: "j1", type: "script", name: "unit", state: "failed" }] }),
    log: async () => `FAIL ${TEST}\nError: Test timed out in 5000ms\n`,
    ...over,
  });
  const deps = (path: string, buildkite: KnownDeps["buildkite"]): KnownDeps => ({ buildkite, storePath: path, repoSlug: "loggd" });

  it("reads the build the check links, digests its failed jobs and judges them against the store", async () => {
    const path = storePath();
    await withStore(path, (open) => {
      open.cases[`flake:${TEST}`] = kase();
    });
    const verdict = await readKnownRed(deps(path, reads()), HEAD, ["buildkite/loggd"], ROLLUP);
    expect(verdict).toMatchObject({ kind: "known", target: { build: 4821, jobs: ["j1"] } });
  });

  it("is unknown without a token, on a red outside Buildkite, or on a build of another commit", async () => {
    const path = storePath();
    expect((await readKnownRed(deps(path, null), HEAD, ["buildkite/loggd"], ROLLUP)).kind).toBe("unknown");
    expect((await readKnownRed(deps(path, reads()), HEAD, ["buildkite/loggd", "Vercel"], ROLLUP)).why).toContain("Vercel");
    expect((await readKnownRed(deps(path, reads()), HEAD, ["buildkite/loggd"], [])).kind).toBe("unknown");
    const moved = reads({ build: async () => ({ ...build, commit: "d".repeat(40) }) });
    expect((await readKnownRed(deps(path, moved), HEAD, ["buildkite/loggd"], ROLLUP)).kind).toBe("unknown");
  });

  it("waits on a build still running and on a Buildkite that cannot be read", async () => {
    const path = storePath();
    const running = reads({ build: async () => ({ ...build, state: "failing" }) });
    expect((await readKnownRed(deps(path, running), HEAD, ["buildkite/loggd"], ROLLUP)).kind).toBe("wait");
    const down = reads({
      build: async () => {
        throw new Error("Buildkite 502");
      },
    });
    expect(await readKnownRed(deps(path, down), HEAD, ["buildkite/loggd"], ROLLUP)).toMatchObject({
      kind: "wait",
      why: "Buildkite could not be read (Buildkite 502)",
    });
  });
});
