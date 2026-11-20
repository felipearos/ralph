// @vitest-environment node
/**
 * The adapter over a scripted runtime: every CLI it runs is answered by the
 * world in `adapter-script.ts`, so these cases pin what the adapter asks
 * (argv, cwd, environment), what it does with each answer, and which failure
 * blanks one field and which fails the snapshot. What each CLI prints for a
 * given disk is that CLI's own suite's; the real-CLI contracts kept for this
 * side of the seam (the roles roster, the run-scoped reads, a read-only frontier
 * census) are in `adapter-runtime-reads.test.ts`.
 *
 * The drift cases are the other half: the CLI JSON is a contract, so a shape
 * the adapter was not written against has to throw, not be coerced. Those go
 * through the exported narrowers with literal malformed values.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  ADAPTER_ENV,
  COMMAND_SURFACE,
  FRONTIER_TTL_MS,
  RalphContractError,
  configCheckout,
  githubRepoUrl,
  narrowFollowing,
  narrowFrontier,
  narrowPresence,
  narrowRoster,
  narrowSnapshot,
  readLoopName,
  readRepoUrl,
} from "./adapter";
import {
  CLI_DIR,
  adapterWorld,
  fail,
  loopReport,
  loopStateAnswer,
  observeIn,
  ok,
  okText,
  presence,
  projectConfigAnswer,
  projectConfigIn,
} from "./adapter-script";
import { parseAgentConfig, parseWorktreeList } from "./agents-adapter";
import {
  HUMAN_REASONS,
  LOOP_ROLES,
  ROLE_PANELS,
  ROLE_SUMMARIES,
  TRIAGE_BUCKETS,
  coderRoster,
  javRoutedRoles,
  readOnlyCheckoutRoles,
} from "./contracts";
import { ROLES, readOnlyCheckout, roleDescriptor } from "../roles";
import { HUMAN_REASONS as HARNESS_HUMAN_REASONS, TRIAGE_BUCKETS as FRONTIER_TRIAGE_BUCKETS } from "../frontier/next-tasks";
import { cleanupFixtures, scratchRoot, writeProjectConfig } from "./fixtures";

afterAll(cleanupFixtures);

describe("the adapter over the runtime", () => {
  it("reads the roster from the project's config, the source the loops use", async () => {
    const world = adapterWorld("roster", { loops: ["nova", "vera"] });
    const nova = world.worktree("wt-nova");
    const ralph = world.worktree("wt-ralph");
    world.answer("loopState", loopStateAnswer([loopReport(nova, { loop: "nova" }), loopReport(ralph, { loop: "ralph" })]));

    const snapshot = await world.adapter().read();
    expect(snapshot.roster).toEqual(coderRoster("nova", "vera"));
    const byWorktree = Object.fromEntries(snapshot.loops.map((loop) => [loop.worktree, loop.identity]));
    // ralph is another project's name here: this project's fence does not know it.
    expect(byWorktree).toEqual({ [nova]: "nova", [ralph]: null });
  });

  it("gives each project the roster its own config names", async () => {
    const world = adapterWorld("rosters");
    const other = world.worktree("other");
    world.answer(projectConfigIn(other), ok(projectConfigAnswer(["ralph", "zed"])));
    expect((await world.adapter().read()).roster).toEqual(coderRoster("ralph", "rafa", "remo", "rulo"));
    expect((await world.adapter({ roots: [other] }).read()).roster).toEqual(coderRoster("ralph", "zed"));
    // Each project's config was read under its own root.
    expect(world.callsTo("projectConfig").map((invocation) => invocation.env[ADAPTER_ENV.project])).toEqual([
      world.root,
      other,
    ]);
  });

  it("follows a roster change without a restart", async () => {
    // The config read is cached on the config file's stat stamp, so the file
    // on disk is what tells the adapter to ask again.
    const world = adapterWorld("roster-change");
    writeProjectConfig(world.root);
    const adapter = world.adapter();
    expect((await adapter.read()).roster).toEqual(coderRoster("ralph", "rafa", "remo", "rulo"));
    await adapter.read();
    expect(world.callsTo("projectConfig")).toHaveLength(1);

    const grown = ["ralph", "rafa", "remo", "rulo", "nova"];
    writeProjectConfig(world.root, grown);
    world.answer("projectConfig", ok(projectConfigAnswer(grown)));
    expect((await adapter.read()).roster).toEqual(coderRoster(...grown));
    expect(world.callsTo("projectConfig")).toHaveLength(2);
  });

  it("refuses to guess a roster when the project config cannot be read", async () => {
    // What `project-config --json` does for a config whose `loops` is empty.
    const world = adapterWorld("roster-broken").answer("projectConfig", fail(1, "'loops' must name at least one loop"));
    await expect(world.adapter().read()).rejects.toThrow(/cannot read the project config/);
  });

  it("says the folder is gone, not that its config is, when the project folder was deleted", async () => {
    // A deleted folder fails the config read just as a folder that never opted in does.
    const world = adapterWorld("roster-gone").answer("projectConfig", fail(1, "cannot read …/.ralph/config.json (ENOENT)"));
    const gone = join(world.root, "deleted");
    await expect(world.adapter({ roots: [gone] }).readLocal()).rejects.toThrow(`the project folder ${gone} does not exist`);
  });

  it("enumerates worktrees, attributes loops, and excludes non-loops", async () => {
    const world = adapterWorld("attribute");
    const ralph = world.worktree("wt-ralph");
    const rafa = world.worktree("wt-rafa");
    const buildkite = world.worktree("wt-buildkite");
    world.answer(
      "loopState",
      loopStateAnswer([
        loopReport(ralph, { loop: "ralph" }),
        loopReport(rafa, { loop: "rafa" }),
        loopReport(buildkite, { state: null }),
      ]),
    );

    const snapshot = await world.adapter().read();
    expect(snapshot.roster).toEqual(coderRoster("ralph", "rafa", "remo", "rulo"));
    const byWorktree = Object.fromEntries(snapshot.loops.map((loop) => [loop.worktree, loop]));
    expect(byWorktree[ralph]?.identity).toBe("ralph");
    expect(byWorktree[rafa]?.identity).toBe("rafa");
    expect(byWorktree[buildkite]?.identity).toBeNull();
    expect(snapshot.loops).toHaveLength(3);
  });

  it("attributes a loop whose only identity is ralph/.loop-name", async () => {
    const world = adapterWorld("loop-name");
    const remo = world.worktree("wt-remo");
    world.answer("loopState", loopStateAnswer([loopReport(remo, { state: null })]));
    expect(readLoopName(remo)).toBeNull();
    writeFileSync(join(remo, ".ralph", "loop-name"), "remo\n");
    expect(readLoopName(remo)).toBe("remo");

    const snapshot = await world.adapter().read();
    const report = snapshot.loops.find((loop) => loop.worktree === remo);
    expect(report?.identity).toBe("remo");
    expect(report?.state).toBeNull();
  });

  it("degrades a foreign record to unknown while keeping the loop's identity", async () => {
    const world = adapterWorld("foreign");
    const rafa = world.worktree("wt-rafa", "rafa");
    // A copied or moved checkout carries somebody else's record. The path is
    // the record's identity, so loop-state ignores it rather than adopting it.
    world.answer(
      "loopState",
      loopStateAnswer([{ ...loopReport(rafa, { state: null }), stateProblem: "foreign", loopStatus: "unknown" }]),
    );

    const snapshot = await world.adapter().read();
    const report = snapshot.loops.find((loop) => loop.worktree === rafa);
    expect(report?.stateProblem).toBe("foreign");
    expect(report?.state).toBeNull();
    expect(report?.identity).toBe("rafa");
    expect(report?.loopStatus).toBe("unknown");
  });

  it("fans out observe per worktree and carries its presence back", async () => {
    const world = adapterWorld("observe");
    const ralph = world.worktree("wt-ralph");
    const rafa = world.worktree("wt-rafa");
    world.answer("loopState", loopStateAnswer([loopReport(ralph, { loop: "ralph" }), loopReport(rafa, { loop: "rafa" })]));
    world.answer(observeIn(ralph), ok(presence({ loop: "ralph", branch: "ralph/919-scaffold" })));
    world.answer(observeIn(rafa), ok(presence({ loop: "rafa" })));

    const snapshot = await world.adapter().read();
    const report = snapshot.loops.find((loop) => loop.worktree === ralph);
    expect(report?.presence).toMatchObject({ loop: "ralph", branch: "ralph/919-scaffold" });
    const other = snapshot.loops.find((loop) => loop.worktree === rafa);
    expect(other?.presence?.loop).toBe("rafa");
    // One observer per worktree, each run from the harness for that worktree.
    const observed = world.callsTo("observe");
    expect(observed.map((invocation) => invocation.env[ADAPTER_ENV.observerRoot]).sort()).toEqual([rafa, ralph].sort());
    for (const invocation of observed) expect(invocation.cwd).toBe(CLI_DIR);
  });

  it("carries each stage actor observe projects from the loop's own timeline", async () => {
    const world = adapterWorld("actors");
    const ralph = world.worktree("wt-ralph");
    const rafa = world.worktree("wt-rafa");
    world.answer("loopState", loopStateAnswer([loopReport(ralph, { loop: "ralph" }), loopReport(rafa, { loop: "rafa" })]));
    // observe derives the actors from the timeline, newest stage first; the
    // adapter carries them as observe ordered them.
    const actor = (over: Record<string, unknown>) => ({
      invocation: null,
      runner: null,
      model: null,
      startedAt: null,
      endedAt: null,
      lastAction: null,
      activityAt: null,
      ...over,
    });
    world.answer(
      observeIn(ralph),
      ok(
        presence({
          loop: "ralph",
          iteration: { index: 3, max: 50 },
          issue: 919,
          actors: [
            actor({ stage: "executor", state: "running", invocation: "e1", runner: "claude", model: "opus", startedAt: "2026-09-13T11:06:00.000Z" }),
            actor({
              stage: "mapper",
              state: "completed",
              invocation: "m1",
              runner: "opencode",
              model: "gpt-mini",
              startedAt: "2026-09-13T11:00:00.000Z",
              endedAt: "2026-09-13T11:05:00.000Z",
            }),
          ],
        }),
      ),
    );
    world.answer(observeIn(rafa), ok(presence({ loop: "rafa" })));

    const snapshot = await world.adapter().read();
    const ralphPresence = snapshot.loops.find((loop) => loop.worktree === ralph)?.presence;
    expect(ralphPresence?.loop).toBe("ralph");
    expect(ralphPresence?.iteration).toEqual({ index: 3, max: 50 });
    expect(ralphPresence?.issue).toBe(919);
    expect(ralphPresence?.actors).toEqual([
      expect.objectContaining({
        stage: "executor",
        state: "running",
        runner: "claude",
        model: "opus",
        startedAt: "2026-09-13T11:06:00.000Z",
        endedAt: null,
      }),
      expect.objectContaining({
        stage: "mapper",
        state: "completed",
        runner: "opencode",
        model: "gpt-mini",
        startedAt: "2026-09-13T11:00:00.000Z",
        endedAt: "2026-09-13T11:05:00.000Z",
        // No tool or prose event reached observe, so no last action: absent, not guessed.
        lastAction: null,
      }),
    ]);
    // Each worktree's observe result stays with that worktree's loop.
    const rafaPresence = snapshot.loops.find((loop) => loop.worktree === rafa)?.presence;
    expect(rafaPresence?.loop).toBe("rafa");
    expect(rafaPresence?.actors).toEqual([]);
  });

  it("degrades a broken observe to absent without taking the snapshot down", async () => {
    const world = adapterWorld("degrade");
    const ralph = world.worktree("wt-ralph");
    world.answer("loopState", loopStateAnswer([loopReport(ralph, { loop: "ralph" })]));
    world.answer("observe", fail(7, "broken"));

    const snapshot = await world.adapter().read();
    expect(snapshot.loops[0]?.identity).toBe("ralph");
    expect(snapshot.loops[0]?.presence).toBeNull();
  });

  it("fails loudly when observe emits a drifted shape", async () => {
    const world = adapterWorld("drift-observe");
    const ralph = world.worktree("wt-ralph");
    world.answer("loopState", loopStateAnswer([loopReport(ralph, { loop: "ralph" })]));
    world.answer("observe", ok({ loop: 5 }));

    await expect(world.adapter().read()).rejects.toBeInstanceOf(RalphContractError);
  });

  it("dedupes a worktree a second root also enumerates", async () => {
    const world = adapterWorld("dedupe");
    const ralph = world.worktree("wt-ralph");
    world.answer("loopState", loopStateAnswer([loopReport(ralph, { loop: "ralph" })]));
    const snapshot = await world.adapter({ roots: [world.root, world.root] }).read();
    expect(snapshot.loops).toHaveLength(1);
    // Both roots were enumerated; the worktree they share became one loop.
    expect(world.callsTo("loopState")).toHaveLength(2);
  });

  it("names the environment variables and command surface it uses", () => {
    expect(ADAPTER_ENV).toEqual({
      loopStateRoot: "RALPH_STATE_ROOT",
      observerRoot: "RALPH_OBSERVER_ROOT",
      project: "RALPH_PROJECT",
      runId: "RALPH_RUN_ID",
      session: "RALPH_SESSION_ID",
      journalDir: "RALPH_JOURNAL_DIR",
      timelineRoot: "RALPH_TIMELINE_ROOT",
      failureLog: "RALPH_RUNNER_FAILURE_LOG",
    });
    expect(COMMAND_SURFACE.loopState).toEqual({
      contract: "loop-state",
      script: "loop-state.ts",
      args: ["status", "--json"],
    });
    expect(COMMAND_SURFACE.observe).toEqual({
      contract: "observe",
      script: "observe.ts",
      args: ["--json"],
    });
  });
});

describe("the frontier read", () => {
  it("reads the backlog once per snapshot from the first root, as a dry run", async () => {
    const world = adapterWorld("frontier");
    const snapshot = await world.adapter().read();
    expect(snapshot.frontier).toMatchObject({
      view: { ready: [], occupied: [], specs: [], inFlight: [], blocked: [], gates: [], stuck: [], tree: [] },
      problem: null,
    });
    expect(COMMAND_SURFACE.frontier.args).toEqual(["--dry-run", "--json"]);
    const [frontier, ...more] = world.callsTo("frontier");
    expect(more).toEqual([]);
    expect(frontier!.args.slice(1)).toEqual([...COMMAND_SURFACE.frontier.args]);
    expect(frontier!.cwd).toBe(world.root);
    expect(frontier!.env[ADAPTER_ENV.project]).toBe(configCheckout(world.root));
    // The census's own `gh` reads are next-tasks.ts's: that they are reads is
    // pinned against the real CLI in adapter-runtime-reads.test.ts.
    // Beside it the adapter makes its claim read and its two PR-status lists,
    // all reads; they run concurrently, so arrival order is not contractual.
    const gh = world.rec.calls.map((call) => call.invocation).filter((invocation) => invocation.command === "gh");
    expect(gh.map((invocation) => invocation.args.join(" ")).sort()).toEqual(
      [COMMAND_SURFACE.github, COMMAND_SURFACE.pullsOpen, COMMAND_SURFACE.pullsMerged].map((surface) => surface.args.join(" ")).sort(),
    );
    for (const invocation of gh) {
      expect(invocation.args.join(" ")).not.toMatch(/\b(edit|create|close|comment|mutation)\b|--add-label|--remove-label/);
    }
  });

  it("serves one census for the TTL rather than one per poll", async () => {
    const world = adapterWorld("frontier-cache");
    const adapter = world.adapter();
    const first = await adapter.read();
    const second = await adapter.read();
    expect(second.frontier).toEqual(first.frontier);
    // Only the adapter's own claim read ran again.
    expect(world.callsTo("frontier")).toHaveLength(1);
    expect(world.callsTo("github")).toHaveLength(2);
    // Past the TTL, the next snapshot asks for the backlog again.
    world.clock.t += FRONTIER_TTL_MS + 1;
    await adapter.read();
    expect(world.callsTo("frontier")).toHaveLength(2);
  });

  it("reports an unreadable frontier as unknown with its reason, never as empty", async () => {
    // What next-tasks.ts does when its census cannot reach gh.
    const world = adapterWorld("frontier-down").answer("frontier", fail(1, "next-tasks: gh: not logged in to github.com"));
    const snapshot = await world.adapter().read();
    expect(snapshot.frontier?.view).toBeNull();
    expect(snapshot.frontier?.problem).toContain("gh");
  });

  it("keeps the frontier's contract: a drifted document is an error, not a wrong backlog", () => {
    expect(() => narrowFrontier({ ready: [], occupied: [], specs: [], inFlight: [], blocked: [], gates: [] })).toThrow(
      RalphContractError,
    );
    expect(() =>
      narrowFrontier({
        ready: [{ spec: null, staffingGroup: null, waiting: 0, tickets: [{ number: "1", title: "x", frees: 0, stuck: null }] }],
        occupied: [],
        specs: [],
        inFlight: [],
        blocked: [],
        gates: [],
        stuck: [],
        tree: [],
        stuckReasons: [],
        untriaged: [],
        triage: { staffing: 0, routing: 0, intake: 0, oversize: 0, rescue: 0 },
      }),
    ).toThrow(/ready\[0\]\.tickets\[0\]\.number/);
  });

  describe("the triager's intake on the frontier", () => {
    const empty = {
      ready: [],
      occupied: [],
      specs: [],
      inFlight: [],
      blocked: [],
      gates: [],
      stuck: [],
      tree: [],
      stuckReasons: [],
      untriaged: [],
      triage: { staffing: 0, routing: 0, intake: 0, oversize: 0, rescue: 0 },
    };

    it("carries the untriaged tickets and a count for every bucket", () => {
      const view = narrowFrontier({
        ...empty,
        untriaged: [{ number: 1131, title: "Diary heatmap" }],
        triage: { staffing: 1, routing: 2, intake: 4, oversize: 0, rescue: 3 },
      });
      expect(view.untriaged).toEqual([{ number: 1131, title: "Diary heatmap" }]);
      expect(view.triage).toEqual({ staffing: 1, routing: 2, intake: 4, oversize: 0, rescue: 3 });
    });

    it("refuses a report missing either of them, or a count that is not one", () => {
      // A missing bucket is drift, not zero: a panel that drew a zero would
      // tell the operator the backlog is clear when nobody knows.
      const { untriaged: _u, ...noUntriaged } = empty;
      expect(() => narrowFrontier(noUntriaged)).toThrow(/untriaged/);
      const { triage: _t, ...noTriage } = empty;
      expect(() => narrowFrontier(noTriage)).toThrow(/\$\.triage/);
      expect(() => narrowFrontier({ ...empty, triage: { ...empty.triage, intake: -1 } })).toThrow(/\$\.triage\.intake/);
      expect(() => narrowFrontier({ ...empty, triage: { staffing: 0, routing: 0, intake: 0 } })).toThrow(
        /\$\.triage\.oversize/,
      );
    });

    it("mirrors the harness's bucket list, so a new bucket cannot reach the dashboard as drift", () => {
      // Same argument as the role list: `contracts.ts` imports no ralph module,
      // so its copy of the buckets is a mirror and has to be fenced. A bucket
      // added to the intake and not here would read as a contract error.
      expect([...TRIAGE_BUCKETS]).toEqual([...FRONTIER_TRIAGE_BUCKETS]);
    });
  });

  describe("what waits on the operator", () => {
    const empty = {
      ready: [],
      occupied: [],
      specs: [],
      inFlight: [],
      blocked: [],
      gates: [],
      stuck: [],
      tree: [],
      stuckReasons: [],
      untriaged: [],
      triage: { staffing: 0, routing: 0, intake: 0, oversize: 0, rescue: 0 },
    };
    const node = {
      number: 166,
      title: "Store schema",
      state: "ready",
      stuck: null,
      detail: null,
      otherBlockers: [],
      heldBy: null,
      frees: 5,
      children: [],
    };
    const group = { spec: null, under: null, subSpecs: [], total: 1, complete: false, specStillOpen: false };

    it("carries the flat list and each tree node's reason", () => {
      const view = narrowFrontier({
        ...empty,
        tree: [{ ...group, roots: [{ ...node, human: "held" }] }],
        human: [{ number: 166, title: "Store schema", reason: "held" }],
      });
      expect(view.human).toEqual([{ number: 166, title: "Store schema", reason: "held" }]);
      expect(view.tree[0]!.roots[0]!.human).toBe("held");
    });

    it("reads a frontier that predates the field as nothing waiting, not as drift", () => {
      // The script runs from the harness's origin/main, which can lag the
      // dashboard by a deploy; refusing the whole backlog over it would be worse.
      const view = narrowFrontier({ ...empty, tree: [{ ...group, roots: [node] }] });
      expect(view.human).toEqual([]);
      expect(view.tree[0]!.roots[0]!.human).toBeNull();
    });

    it("refuses a reason it does not know", () => {
      expect(() => narrowFrontier({ ...empty, human: [{ number: 1, title: "x", reason: "later" }] })).toThrow(
        /human\[0\]\.reason/,
      );
    });

    it("mirrors the harness's reasons, so a new one cannot reach the dashboard as drift", () => {
      expect([...HARNESS_HUMAN_REASONS]).toEqual([...HUMAN_REASONS]);
    });
  });

  describe("stuck reasons", () => {
    const empty = {
      ready: [],
      occupied: [],
      specs: [],
      inFlight: [],
      blocked: [],
      gates: [],
      stuck: [],
      tree: [],
      untriaged: [],
      triage: { staffing: 0, routing: 0, intake: 0, oversize: 0, rescue: 0 },
    };
    const migration = {
      number: 1219,
      title: "Streaming region preference",
      kind: "migration",
      reason: "needs-migration: draft PR #1242 ready; apply drizzle/0062_streaming_region.sql (additive column) before merging",
      pr: 1242,
      migration: "drizzle/0062_streaming_region.sql",
      at: "2026-09-23T10:21:00Z",
    };
    const other = { number: 1109, title: "Episode progress sync", kind: "other", reason: "Blocked: PR #1276 red twice", pr: 1276, migration: null, at: null };

    const park = {
      loop: "rafa",
      label: "rafa-blocked",
      pr: 1276,
      summary: "waits on the visual baseline from build 3191",
      condition: { kind: "check", name: "buildkite/visual", on: "pr" },
      since: "2026-11-10T08:00:00Z",
      budgetUntil: "2026-11-12T08:00:00Z",
      remainingSeconds: 86_400,
      expired: false,
      escalatedAt: null,
    };

    it("carries a migration block apart from any other, with what to apply", () => {
      const parked = [{ ...migration, park: null }, { ...other, park: null }];
      expect(narrowFrontier({ ...empty, stuckReasons: parked }).stuckReasons).toEqual(parked);
    });

    it("carries the frontier's park for a stuck ticket field for field (#777)", () => {
      const parked = { ...other, park };
      expect(narrowFrontier({ ...empty, stuckReasons: [parked] }).stuckReasons).toEqual([parked]);
      for (const condition of [
        { kind: "reference", ref: "felipearos/ralph#776" },
        { kind: "step", check: "buildkite/ci", step: "visual" },
        { kind: "label-removed", label: "needs-design" },
      ]) {
        const view = narrowFrontier({ ...empty, stuckReasons: [{ ...other, park: { ...park, condition } }] });
        expect(view.stuckReasons[0]?.park?.condition).toEqual(condition);
      }
    });

    it("reads a null park, or one an older frontier never printed, as no park", () => {
      expect(narrowFrontier({ ...empty, stuckReasons: [{ ...other, park: null }] }).stuckReasons[0]?.park).toBeNull();
      expect(narrowFrontier({ ...empty, stuckReasons: [other] }).stuckReasons[0]?.park).toBeNull();
    });

    it("refuses a park it cannot read, like any other malformed field", () => {
      const withPark = (value: unknown) => ({ ...empty, stuckReasons: [{ ...other, park: value }] });
      expect(() => narrowFrontier(withPark({ ...park, condition: { kind: "deploy", ref: "x" } }))).toThrow(
        /stuckReasons\[0\]\.park\.condition\.kind/,
      );
      expect(() => narrowFrontier(withPark({ ...park, condition: { kind: "check", name: "ci", on: "branch" } }))).toThrow(
        /stuckReasons\[0\]\.park\.condition\.on/,
      );
      expect(() => narrowFrontier(withPark({ ...park, condition: { kind: "step", check: "ci" } }))).toThrow(
        /stuckReasons\[0\]\.park\.condition\.step/,
      );
      expect(() => narrowFrontier(withPark({ ...park, expired: "no" }))).toThrow(/stuckReasons\[0\]\.park\.expired/);
      expect(() => narrowFrontier(withPark({ ...park, remainingSeconds: -1 }))).toThrow(
        /stuckReasons\[0\]\.park\.remainingSeconds/,
      );
      expect(() => narrowFrontier(withPark("parked"))).toThrow(/stuckReasons\[0\]\.park/);
    });

    it("refuses a report without them, or with a kind it does not know", () => {
      expect(() => narrowFrontier(empty)).toThrow(/stuckReasons/);
      expect(() => narrowFrontier({ ...empty, stuckReasons: [{ ...other, kind: "ci" }] })).toThrow(/stuckReasons\[0\]\.kind/);
      expect(() => narrowFrontier({ ...empty, stuckReasons: [{ ...migration, pr: "1242" }] })).toThrow(/stuckReasons\[0\]\.pr/);
    });
  });
});

const followingWatch = {
  pr: 574,
  ticket: 563,
  ticketRef: "#563",
  mode: "observe",
  round: 1,
  mergedAt: "2026-10-29T10:00:00.000Z",
  deployedAt: "2026-10-29T10:05:00.000Z",
  deployUrl: "https://example.vercel.app",
  openedAt: "2026-10-29T10:06:00.000Z",
  state: "in-progress",
  nextCheckIn: { offsetHours: 1, dueAt: "2026-10-29T11:05:00.000Z" },
  checkInsDone: 0,
  checkInsTotal: 3,
  verdict: null,
  wouldBe: [{ verdict: "ticket", reason: "500 on /feed", at: 1 }],
  notVerifiableLive: [{ criterion: "emails arrive", detail: null }],
};

describe("the following read", () => {
  // A verifier loop needs the config's `verifier` block, or the roster itself is refused.
  const withVerifier = (label: string) =>
    adapterWorld(label, {
      loops: ["ralph", { name: "sent", role: "verifier" }],
      config: {
        verifier: {
          productionUrl: "https://example.app",
          deploy: { source: "vercel", project: "prj_example" },
          sentry: { org: "example", project: "web" },
        },
      },
    });

  it("carries the narrowed view when the roster names a verifier", async () => {
    const world = withVerifier("following").answer("following", ok({ version: 1, watches: [followingWatch] }));
    const snapshot = await world.adapter().read();
    expect(snapshot.following).toMatchObject({ view: { version: 1, watches: [followingWatch] }, problem: null });
    expect(typeof snapshot.following?.readAt).toBe("string");
  });

  it("degrades a CLI that exits 1 to unknown with its stderr reason, and the snapshot still resolves", async () => {
    const world = withVerifier("following-down").answer("following", fail(1, "the watch store is unreadable\n"));
    const snapshot = await world.adapter().read();
    expect(snapshot.following?.view).toBeNull();
    expect(snapshot.following?.problem).toBe("the watch store is unreadable");
    expect(snapshot.roster.map((entry) => entry.name)).toEqual(["ralph", "sent"]);
  });

  it("degrades output that is not JSON, or not the view, instead of throwing", async () => {
    const world = withVerifier("following-drift").answer("following", okText("nope\n"));
    const notJson = await world.adapter().read();
    expect(notJson.following).toMatchObject({ view: null, problem: expect.stringMatching(/not JSON/) });
    // A new adapter: the first one serves its Following read for the TTL.
    world.answer("following", ok({ version: 2, watches: [] }));
    const drifted = await world.adapter().read();
    expect(drifted.following).toMatchObject({ view: null, problem: expect.stringMatching(/\$\.version/) });
  });

  it("never runs the CLI, and leaves the field absent, when no verifier is on the roster", async () => {
    const world = adapterWorld("following-none");
    const snapshot = await world.adapter().read();
    expect(snapshot).not.toHaveProperty("following");
    expect(world.callsTo("following")).toEqual([]);
  });

  it("reads exactly the CLI's shape, and an empty store is an empty view", () => {
    expect(narrowFollowing({ version: 1, watches: [] })).toEqual({ version: 1, watches: [] });
    expect(narrowFollowing({ version: 1, watches: [followingWatch] }).watches).toEqual([followingWatch]);
    const finished = {
      ...followingWatch,
      state: "finished",
      nextCheckIn: null,
      verdict: { verdict: "verified", reason: "nothing wrong at the last check-in", act: false, wouldHaveBeen: "verified" },
    };
    expect(narrowFollowing({ version: 1, watches: [finished] }).watches[0]?.verdict?.verdict).toBe("verified");
  });

  it("refuses a drifted top level, but drops one watch whose enum it does not know", () => {
    expect(() => narrowFollowing([])).toThrow(RalphContractError);
    expect(() => narrowFollowing({ version: 2, watches: [] })).toThrow(/\$\.version/);
    expect(() => narrowFollowing({ version: 1 })).toThrow(/\$\.watches/);
    expect(() => narrowFollowing({ version: 1, watches: [{ ...followingWatch, pr: "574" }] })).toThrow(
      /watches\[0\]\.pr/,
    );
    const odd = [
      { ...followingWatch, pr: 1, state: "paused" },
      { ...followingWatch, pr: 2, wouldBe: [{ verdict: "rollback", reason: "x", at: null }] },
      followingWatch,
    ];
    expect(narrowFollowing({ version: 1, watches: odd }).watches.map((watch) => watch.pr)).toEqual([574]);
  });
});

describe("the repo a loop links to", () => {
  it.each([
    "https://github.com/felipearos/loggd.git",
    "https://github.com/felipearos/loggd",
    "https://x-access-token:secret@github.com/felipearos/loggd.git",
    "git@github.com:felipearos/loggd.git",
    "ssh://git@github.com/felipearos/loggd",
  ])("reads %s as the GitHub repo", (remote) => {
    expect(githubRepoUrl(remote)).toBe("https://github.com/felipearos/loggd");
  });

  it("has no link for a remote that is not GitHub", () => {
    expect(githubRepoUrl("https://gitlab.com/felipearos/loggd.git")).toBeNull();
    expect(githubRepoUrl(null)).toBeNull();
  });

  it("follows a linked worktree's .git file to the shared config's origin", () => {
    const root = scratchRoot("repo-url");
    const common = join(root, "main", ".git");
    const linked = join(common, "worktrees", "wt-rafa");
    mkdirSync(linked, { recursive: true });
    writeFileSync(
      join(common, "config"),
      [
        "[core]",
        "\tbare = false",
        '[remote "upstream"]',
        "\turl = https://github.com/someone/fork.git",
        '[remote "origin"]',
        "\turl = git@github.com:felipearos/loggd.git",
        "\tfetch = +refs/heads/*:refs/remotes/origin/*",
        "",
      ].join("\n"),
    );
    writeFileSync(join(linked, "commondir"), "../..\n");
    const rafa = join(root, "wt-rafa");
    mkdirSync(rafa);
    writeFileSync(join(rafa, ".git"), `gitdir: ${linked}\n`);
    expect(readRepoUrl(rafa)).toBe("https://github.com/felipearos/loggd");
  });

  it("has no link for a checkout without a git dir", () => {
    const remo = join(scratchRoot("repo-none"), "wt-remo");
    mkdirSync(remo);
    expect(readRepoUrl(remo)).toBeNull();
  });
});

describe("the contract guard", () => {
  const validSnapshot = {
    self: "/checkout",
    loops: [],
    reconciliation: { orphaned: [], prunable: [] },
  };

  it("accepts the shape the CLI emits", () => {
    expect(narrowSnapshot(validSnapshot).self).toBe("/checkout");
  });

  it("rejects a missing or renamed top-level field", () => {
    expect(() =>
      narrowSnapshot({ loops: [], reconciliation: { orphaned: [], prunable: [] } }),
    ).toThrow(RalphContractError);
    expect(() => narrowSnapshot({ ...validSnapshot, reconciliation: undefined })).toThrow(
      /reconciliation/,
    );
  });

  it("rejects a loop status the type cannot name rather than coercing it", () => {
    const drifted = {
      ...validSnapshot,
      loops: [
        {
          worktree: "/checkout",
          worktreeStatus: "live",
          loopStatus: "on-fire",
          branch: null,
          state: null,
          stateProblem: null,
          supervisor: "alive",
        },
      ],
    };
    expect(() => narrowSnapshot(drifted)).toThrow(/loopStatus/);
  });

  it("requires a present record to carry version 1", () => {
    expect(() =>
      narrowSnapshot({
        ...validSnapshot,
        loops: [
          {
            worktree: "/checkout",
            worktreeStatus: "live",
            loopStatus: "unknown",
            branch: null,
            state: {
              version: 2,
              run: "r",
              owner: { loop: "ralph", pid: null, host: "h" },
              worktree: "/checkout",
              branch: null,
              stage: "iteration",
              iteration: null,
              heartbeat: "T",
              lastEvent: null,
              stopReason: null,
            },
            stateProblem: null,
            supervisor: "dead",
          },
        ],
      }),
    ).toThrow(/version/);
  });

  it("carries a known phase and leaves out one it cannot name, without failing the record", () => {
    const record = (phase: unknown, resumedAt?: unknown) =>
      narrowSnapshot({
        ...validSnapshot,
        loops: [
          {
            worktree: "/checkout",
            worktreeStatus: "live",
            loopStatus: "running",
            branch: null,
            state: {
              version: 1,
              run: "r",
              owner: { loop: "ralph", pid: null, host: "h" },
              worktree: "/checkout",
              branch: null,
              stage: "iteration",
              iteration: null,
              heartbeat: "T",
              lastEvent: null,
              stopReason: null,
              phase,
              resumedAt,
            },
            stateProblem: null,
            supervisor: "alive",
          },
        ],
      }).loops[0]?.state;
    expect(record("review")?.phase).toBe("review");
    expect(record("daydream")).not.toHaveProperty("phase");
    expect(record(undefined)).not.toHaveProperty("phase");
    expect(record("review", "review")?.resumedAt).toBe("review");
    expect(record("review", "later")).not.toHaveProperty("resumedAt");
    expect(record("review")).not.toHaveProperty("resumedAt");
  });

  it("carries a parseable lastIterationEndAt and leaves out one it cannot read, without failing the record", () => {
    const record = (lastIterationEndAt: unknown) =>
      narrowSnapshot({
        ...validSnapshot,
        loops: [
          {
            worktree: "/checkout",
            worktreeStatus: "live",
            loopStatus: "running",
            branch: null,
            state: {
              version: 1,
              run: "r",
              owner: { loop: "ralph", pid: null, host: "h" },
              worktree: "/checkout",
              branch: null,
              stage: "iteration",
              iteration: null,
              heartbeat: "T",
              lastEvent: null,
              stopReason: null,
              lastIterationEndAt,
            },
            stateProblem: null,
            supervisor: "alive",
          },
        ],
      }).loops[0]?.state;
    expect(record("2026-10-22T03:00:00.000Z")?.lastIterationEndAt).toBe("2026-10-22T03:00:00.000Z");
    expect(record("yesterday-ish")).not.toHaveProperty("lastIterationEndAt");
    expect(record(42)).not.toHaveProperty("lastIterationEndAt");
    expect(record(undefined)).not.toHaveProperty("lastIterationEndAt");
  });

  it("rejects a presence shape that is not the projection", () => {
    expect(() => narrowPresence({ loop: "ralph" })).toThrow(RalphContractError);
    expect(() => narrowPresence(null)).toThrow(RalphContractError);
  });

  it("rejects a presence status or supervisor the runtime cannot emit", () => {
    const valid = {
      loop: "ralph",
      run: null,
      status: "running",
      supervisor: "alive",
      issue: null,
      branch: null,
      iteration: null,
      observedAt: "T",
      issues: [],
      actors: [],
      recent: [],
      failureReason: null,
      step: null,
      phase: { index: 1, total: 5, label: "select and map" },
      warning: null,
    };
    expect(narrowPresence(valid)).toMatchObject({ status: "running", supervisor: "alive" });
    expect(() => narrowPresence({ ...valid, status: "on-fire" })).toThrow(/status/);
    expect(() => narrowPresence({ ...valid, supervisor: "ghost" })).toThrow(/supervisor/);
  });

  it("carries the observer's issue history, agents, activity and reading", () => {
    const full = {
      loop: "rafa",
      run: "rafa-run-1",
      status: "running",
      supervisor: "alive",
      issue: 859,
      branch: "rafa/859-stats",
      iteration: { index: 1, max: 1 },
      observedAt: "T",
      issues: [
        { issue: 859, state: "active", pr: null, draft: false, title: null, detail: null, block: null, at: "T" },
        { issue: 839, state: "blocked", pr: 903, draft: true, title: "revoke comped Pro", detail: "needs-migration", block: "migration", at: "T" },
      ],
      actors: [
        {
          stage: "executor",
          state: "running",
          invocation: "executor-1",
          runner: "claude",
          model: "claude-sonnet-5",
          startedAt: "T",
          endedAt: null,
          lastAction: "text — implementing",
          activityAt: "T",
        },
      ],
      recent: [{ stage: "orchestrator", label: "tool Bash — bun run typecheck", at: "T", iteration: 1, run: "rafa-run-1" }],
      failureReason: null,
      step: { stage: "executor", action: "implementing the issue" },
      phase: { index: 2, total: 5, label: "implement" },
      warning: null,
    };
    expect(narrowPresence(full)).toMatchObject({
      issues: [{ issue: 859, state: "active", block: null }, { issue: 839, pr: 903, detail: "needs-migration", block: "migration" }],
      actors: [{ stage: "executor", state: "running", model: "claude-sonnet-5" }],
      recent: [{ stage: "orchestrator", iteration: 1 }],
      step: { stage: "executor" },
      phase: { index: 2, label: "implement" },
    });
    expect(() => narrowPresence({ ...full, issues: [{ ...full.issues[0], state: "lost" }] })).toThrow(/issues\[0\]\.state/);
    // `unknown` is a frontier answer; a journal outcome is either a block kind or none.
    expect(() => narrowPresence({ ...full, issues: [{ ...full.issues[1], block: "unknown" }] })).toThrow(/issues\[0\]\.block/);
    expect(() => narrowPresence({ ...full, actors: [{ ...full.actors[0], state: "asleep" }] })).toThrow(/actors\[0\]\.state/);
    expect(() => narrowPresence({ ...full, phase: null })).toThrow(/phase/);
  });

  describe("presence detail", () => {
    const actor = {
      stage: "executor",
      state: "running",
      invocation: "inv-1",
      runner: "claude",
      model: "opus",
      startedAt: "2026-09-13T11:58:00.000Z",
      endedAt: null,
      lastAction: "tool Bash — bun run test",
      activityAt: "2026-09-13T11:59:10.000Z",
    };
    const issue = { issue: 919, state: "pr", pr: 40, draft: true, title: "Scaffold", detail: null, block: null, at: "T" };
    const valid = {
      loop: "ralph",
      run: "r",
      status: "running",
      supervisor: "alive",
      issue: 919,
      branch: "ralph/919-scaffold",
      iteration: { index: 3, max: 50 },
      observedAt: "T",
      actors: [actor],
      issues: [issue],
      recent: [],
      failureReason: null,
      step: null,
      phase: { index: 1, total: 5, label: "select and map" },
      warning: null,
      // Fields the dashboard does not read are ignored rather than rejected.
      spinner: "|",
    };

    it("narrows actors and issue history", () => {
      const narrowed = narrowPresence(valid);
      expect(narrowed.actors).toEqual([actor]);
      expect(narrowed.issues).toEqual([issue]);
      expect(narrowed).not.toHaveProperty("spinner");
    });

    it("rejects missing actors or issues rather than defaulting them to empty", () => {
      const { actors: _actors, ...noActors } = valid;
      expect(() => narrowPresence(noActors)).toThrow(/\$\.actors/);
      const { issues: _issues, ...noIssues } = valid;
      expect(() => narrowPresence(noIssues)).toThrow(/\$\.issues/);
    });

    it("rejects an actor state, stage or issue state the runtime cannot emit", () => {
      expect(() => narrowPresence({ ...valid, actors: [{ ...actor, state: "succeeded" }] })).toThrow(
        /\$\.actors\[0\]\.state/,
      );
      expect(() => narrowPresence({ ...valid, actors: [{ ...actor, stage: "reviewer" }] })).toThrow(
        /\$\.actors\[0\]\.stage/,
      );
      expect(() => narrowPresence({ ...valid, actors: [{ ...actor, runner: 7 }] })).toThrow(
        /\$\.actors\[0\]\.runner/,
      );
      expect(() => narrowPresence({ ...valid, issues: [{ ...issue, state: "shipped" }] })).toThrow(
        /\$\.issues\[0\]\.state/,
      );
    });
  });

  it("rejects a project config that names no roster", () => {
    expect(() => narrowRoster({ repo: "o/r" })).toThrow(/\$\.roster/);
    expect(() => narrowRoster({ roster: [] })).toThrow(/names no loops/);
    expect(narrowRoster({ roster: [{ name: "ralph", role: "coder" }] })).toEqual(coderRoster("ralph"));
  });

  it("mirrors the harness's role list, so a new role cannot reach the dashboard as drift", () => {
    // `contracts.ts` imports no ralph module by design, so its copy of the
    // role list is a mirror. Adding a role to `roles.ts` and not here would
    // make every loop in it read as a contract error.
    expect([...LOOP_ROLES]).toEqual([...ROLES]);
  });

  it("mirrors each role's panel rules from its descriptor", () => {
    // The dashboard cannot import `roles.ts`, so the panel rules are a mirror
    // like the role list. A role that stops taking the host lease, or starts
    // running in phases, has to move both.
    for (const role of ROLES) {
      const descriptor = roleDescriptor(role);
      expect(ROLE_PANELS[role]).toEqual({
        pr: descriptor.sigils.includes("AWAIT_PR"),
        hostLease: descriptor.hostLease,
        phases: descriptor.phases,
        // A role has an intake when the frontier has a bucket for it to take
        // units from, which is the same question `frontierBucket` answers.
        triage: descriptor.frontierBucket === "triage",
        // The role whose preflight REQUIRES the `ci-health` label is the role
        // that files cases against it, which is the role whose view of CI
        // health is its own work. Derived rather than compared against
        // `"ci-doctor"`, for the reason `triage` is.
        ciHealth: descriptor.preflight.labels.includes("ci-health"),
      });
    }
  });

  it("mirrors each role's summary from its descriptor", () => {
    for (const role of ROLES) expect(ROLE_SUMMARIES[role]).toBe(roleDescriptor(role).summary);
  });

  it("mirrors which roles a Jav route can be made for", () => {
    // A new agent's Jav readiness item applies to these roles alone. Derived
    // from the role's own `javRouted`, as `jav.ts` and the frontier are, so
    // the three cannot come to disagree about what Jav routes.
    expect([...javRoutedRoles]).toEqual(ROLES.filter((role) => roleDescriptor(role).javRouted));
  });

  it("mirrors which roles must leave the checkout clean and detached", () => {
    // Unblock & resume holds a halted loop's worktree to this before it starts
    // the loop again; a role that gains the invariant has to move both.
    expect([...readOnlyCheckoutRoles]).toEqual(ROLES.filter((role) => readOnlyCheckout(role)));
  });

  it("rejects a roster entry whose role the dashboard does not know", () => {
    // Drift, not a coder: showing an unknown role as the default would hide a
    // loop's panels behind the wrong rules.
    // The message must name the role it did not know: it is all an operator
    // sees when the harness moves ahead of the dashboard.
    expect(() => narrowRoster({ roster: [{ name: "ralph", role: "sleuth" }] })).toThrow(
      /\$\.roster\[0\]\.role expected one of coder, triager, ci-doctor, pr-medic, clerk, verifier, sentinel, got 'sleuth'/,
    );
    expect(() => narrowRoster({ roster: [{ name: "ralph" }] })).toThrow(/\$\.roster\[0\]\.role/);
  });

  it("still reads a config whose roster it cannot narrow, with roster null", () => {
    // Only Create checkout reads the roster. A role this side of the seam does
    // not know must not stop Add agent, Delete agent worktree or Remove
    // project, which never look at one; the one consumer refuses on `null`.
    const drifted = JSON.stringify({ repo: "o/r", baseBranch: "main", loops: ["ralph"], roster: [{ name: "ralph", role: "sleuth" }] });
    expect(parseAgentConfig({ status: 0, stdout: drifted, stderr: "" })).toEqual({
      ok: true,
      value: {
        repo: "o/r",
        owner: null,
        baseBranch: "main",
        displayName: null,
        loops: ["ralph"],
        roster: null,
        // The diagnosis is kept, not discarded: it is the only thing naming
        // the path and the value, and Create checkout quotes it in its refusal.
        rosterWhy: expect.stringContaining("$.roster[0].role"),
        verifier: null,
        sentinel: null,
        configChanges: "commit",
        fragments: { prompt: null, coder: null, plan: null },
        gates: [],
        requiredChecks: [],
        refuseFiles: [],
        worktreeSetup: [],
      },
    });
  });

  it("narrows worktreeSetup in order, filling defaults, and reads a malformed one as empty", () => {
    // Only a new checkout's setup reads the steps, so a malformed list is never
    // a reason to fail the read every agent path makes.
    const steps = [
      { name: "install", command: "bun install", timeoutSeconds: 200, installsDependencies: true },
      { name: "env", command: "cp a b" },
      { name: "no-command" },
      "not-a-step",
    ];
    const spelt = JSON.stringify({ repo: "o/r", baseBranch: "main", loops: [], worktreeSetup: steps });
    expect(parseAgentConfig({ status: 0, stdout: spelt, stderr: "" })).toMatchObject({
      ok: true,
      value: {
        worktreeSetup: [
          { name: "install", command: "bun install", timeoutSeconds: 200, installsDependencies: true },
          { name: "env", command: "cp a b", timeoutSeconds: 120, installsDependencies: false },
        ],
      },
    });
    const malformed = JSON.stringify({ repo: "o/r", baseBranch: "main", loops: [], worktreeSetup: { install: "bun install" } });
    expect(parseAgentConfig({ status: 0, stdout: malformed, stderr: "" })).toMatchObject({ ok: true, value: { worktreeSetup: [] } });
  });

  it("reads owner and displayName, null when absent or not text", () => {
    const spelt = JSON.stringify({ repo: "o/r", owner: "o", displayName: "Proj", baseBranch: "main", loops: [] });
    expect(parseAgentConfig({ status: 0, stdout: spelt, stderr: "" })).toMatchObject({
      ok: true,
      value: { owner: "o", displayName: "Proj" },
    });
    const odd = JSON.stringify({ repo: "o/r", owner: 7, baseBranch: "main", loops: [] });
    expect(parseAgentConfig({ status: 0, stdout: odd, stderr: "" })).toMatchObject({
      ok: true,
      value: { owner: null, displayName: null },
    });
  });

  it("keeps every validation problem project-config lists, and why as its first line", () => {
    // The shape `parseProjectConfig` throws and `project-config`'s main prints.
    const stderr = "project-config: .ralph/config.json is invalid:\n  - repo must be a string\n  - loops must be a list\n";
    expect(parseAgentConfig({ status: 1, stdout: "", stderr })).toEqual({
      ok: false,
      why: "project-config: .ralph/config.json is invalid:",
      problems: ["repo must be a string", "loops must be a list"],
    });
    // A failure that lists nothing carries no `problems` at all.
    expect(parseAgentConfig({ status: 1, stdout: "", stderr: "project-config: ENOENT\n" })).toEqual({
      ok: false,
      why: "project-config: ENOENT",
    });
  });

  it("reads each worktree's branch off its porcelain block, null when detached", () => {
    const stdout = [
      "worktree /root",
      "HEAD " + "a".repeat(40),
      "branch refs/heads/main",
      "",
      "worktree /ws/proj/nova-loop",
      "HEAD " + "b".repeat(40),
      "detached",
      "",
      "worktree /ws/proj/mira-loop",
      "HEAD " + "c".repeat(40),
      "branch refs/heads/ralph/12-thing",
      "",
      "worktree /ws/proj/bare",
      "",
    ].join("\n");
    expect(parseWorktreeList({ status: 0, stdout, stderr: "" })).toEqual({
      ok: true,
      value: [
        { path: "/root", branch: "main", main: true },
        { path: "/ws/proj/nova-loop", branch: null, main: false },
        { path: "/ws/proj/mira-loop", branch: "ralph/12-thing", main: false },
        { path: "/ws/proj/bare", branch: null, main: false },
      ],
    });
  });
});
