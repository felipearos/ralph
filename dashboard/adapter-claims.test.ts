// @vitest-environment node
/**
 * The adapter's claim sources, over a scripted runtime. Leases come from
 * `claim-lease status --json`, GitHub claims from one read-only `gh issue
 * list`; either one failing to run degrades to unavailable, and a drifted
 * shape from either throws. Nothing here spawns: every read is answered by
 * the world's script, so the suite tests the adapter, not the CLIs.
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  COMMAND_SURFACE,
  RalphContractError,
  narrowGithubClaims,
  narrowLeases,
} from "./adapter";
import { adapterWorld, fail, ok } from "./adapter-script";
import { cleanupFixtures, leaseRecord } from "./fixtures";

afterAll(cleanupFixtures);

const issue = (number: number, labels: string[], title = `Ticket ${number}`) => ({
  number,
  title,
  labels: labels.map((name) => ({ name, id: `L_${name}`, color: "000000", description: "" })),
});

/** The store as `claim-lease status --json` prints it. */
const store = (leases: Record<string, unknown>[]) => ok({ version: 1, path: "/state/claim-leases.json", leases });

describe("reading claims through the runtime", () => {
  it("reads leases from claim-lease status and claim labels from gh", async () => {
    const world = adapterWorld("claims")
      // In the order the CLI prints them; the adapter keeps it.
      .answer("claims", store([
        leaseRecord({ issue: 12, loop: "rafa", run: "run-rafa", owner: "rafa@test", branch: null }),
        leaseRecord({ issue: 919, loop: "ralph" }),
      ]))
      .answer("github", ok([
        issue(919, ["ready-for-agent", "ralph-wip"], "Scaffold"),
        issue(12, ["rafa-wip", "remo-blocked"]),
        issue(33, ["nova-wip"]),
        issue(40, ["ready-for-agent"]),
      ]));

    const snapshot = await world.adapter().read();
    expect(snapshot.claims?.leases).toEqual([
      expect.objectContaining({ issue: 12, loop: "rafa", run: "run-rafa", branch: null }),
      expect.objectContaining({ issue: 919, loop: "ralph", expiresAt: "2026-09-13T12:01:00.000Z" }),
    ]);
    // Only roster claim labels become claims; queue, stuck and foreign labels do not.
    expect(snapshot.claims?.github).toEqual([
      { issue: 919, title: "Scaffold", loop: "ralph" },
      { issue: 12, title: "Ticket 12", loop: "rafa" },
    ]);
  });

  it("asks gh for open issues only, once per root, with a read-only verb", async () => {
    const world = adapterWorld("claims-argv");
    await world.adapter().read();
    // Every read the snapshot made was one the script planned for.
    expect(world.rec.calls.filter((call) => call.answer?.status === 127)).toEqual([]);
    // The claim read is exactly the declared one, from the root checkout; the
    // PR-chip reads beside the frontier are the other `gh` calls, and no `gh`
    // call the adapter makes carries a writing verb. That the frontier census's
    // own `gh` calls are reads too is pinned against the real CLI in
    // adapter-runtime-reads.test.ts.
    const gh = world.rec.calls.map((call) => call.invocation).filter((invocation) => invocation.command === "gh");
    const claimReads = gh.filter((invocation) => invocation.args.join(" ") === COMMAND_SURFACE.github.args.join(" "));
    expect(claimReads).toHaveLength(1);
    expect(claimReads[0]).toMatchObject({ command: COMMAND_SURFACE.github.command, cwd: world.root });
    for (const invocation of gh) {
      const call = invocation.args.join(" ");
      expect(call).toMatch(/^((issue|pr) list|api graphql) /);
      expect(call).not.toMatch(/\b(edit|create|close|comment|mutation)\b|--add-label|--remove-label|--add-assignee/);
    }
    expect(COMMAND_SURFACE.github.command).toBe("gh");
    expect(COMMAND_SURFACE.github.args.slice(0, 2)).toEqual(["issue", "list"]);
    expect(COMMAND_SURFACE.github.args).toContain("open");
    expect(COMMAND_SURFACE.claims).toEqual({
      contract: "claim-lease",
      script: "claim-lease.ts",
      args: ["status", "--json"],
    });
  });

  it("reports an empty lease store as no leases, not unavailable", async () => {
    const snapshot = await adapterWorld("claims-empty").adapter().read();
    expect(snapshot.claims).toEqual({ leases: [], github: [] });
  });

  it("degrades a failing gh to unavailable and keeps the leases", async () => {
    const world = adapterWorld("claims-gh-down")
      .answer("claims", store([leaseRecord()]))
      // What an unauthenticated `gh` does.
      .answer("github", fail(4, "gh: not logged in"));
    const snapshot = await world.adapter().read();
    expect(snapshot.claims?.github).toBeNull();
    expect(snapshot.claims?.leases).toHaveLength(1);
  });

  it("degrades a lease store the CLI refuses to unavailable", async () => {
    // `claim-lease status` refuses a store from another version by exiting
    // non-zero; that is a source that could not be read, not drift.
    const world = adapterWorld("claims-store-bad").answer("claims", fail(1, "unsupported store version"));
    const snapshot = await world.adapter().read();
    expect(snapshot.claims?.leases).toBeNull();
    expect(snapshot.claims?.github).toEqual([]);
  });

  it("fails loudly when gh emits a drifted shape", async () => {
    // Only the claim read drifts; the PR-chip reads keep their defaults, and
    // their drift would cost only the chips, never the snapshot.
    const world = adapterWorld("claims-gh-drift").answer("github", ok({ issues: [] }));
    await expect(world.adapter().read()).rejects.toBeInstanceOf(RalphContractError);
  });
});

describe("the claim contract guards", () => {
  const store = { version: 1, path: "/x", leases: [leaseRecord()] };

  it("narrows the lease projection the CLI emits", () => {
    expect(narrowLeases(store)).toEqual([
      {
        issue: 919,
        run: "run-ralph",
        loop: "ralph",
        owner: "ralph@test",
        host: "test",
        worktree: "/checkout/ralph",
        branch: "ralph/919-scaffold",
        claimedAt: "2026-09-13T11:00:00.000Z",
        heartbeatAt: "2026-09-13T11:59:00.000Z",
        expiresAt: "2026-09-13T12:01:00.000Z",
      },
    ]);
  });

  it("rejects a lease projection from another version or with a missing expiry", () => {
    expect(() => narrowLeases({ ...store, version: 2 })).toThrow(/version/);
    const { expiresAt: _dropped, ...noExpiry } = leaseRecord();
    expect(() => narrowLeases({ ...store, leases: [noExpiry] })).toThrow(/expiresAt/);
    expect(() => narrowLeases({ ...store, leases: [leaseRecord({ issue: "919" })] })).toThrow(RalphContractError);
    expect(() => narrowLeases({ version: 1, leases: {} })).toThrow(/leases/);
  });

  it("rejects a gh issue list that is not an array of issues", () => {
    const roster = ["ralph", "rafa", "remo", "rulo"];
    expect(narrowGithubClaims([issue(1, ["remo-wip"])], roster)).toEqual([{ issue: 1, title: "Ticket 1", loop: "remo" }]);
    expect(() => narrowGithubClaims({}, roster)).toThrow(RalphContractError);
    expect(() => narrowGithubClaims([{ number: 1, title: "x" }], roster)).toThrow(/labels/);
    expect(() => narrowGithubClaims([{ number: 1, title: "x", labels: [{}] }], roster)).toThrow(/name/);
  });
});
