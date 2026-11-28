// @vitest-environment node
/**
 * A sentinel or verifier rules save (#787) over a fake adapter: what the
 * commit is called, the order the direct push and its PR fallback run in, and
 * the refusals each path keeps. `agents-http.test.ts` runs the same saves
 * against a real bare `origin`; these pin what that cannot stage cheaply —
 * a push refused for each reason, and the fallback's own failures.
 */
import { describe, expect, it } from "vitest";

import {
  RULES_PR_TTL_MS,
  proposeSentinel,
  proposeVerifier,
  readSentinel,
  readVerifier,
  rulesCommitMessage,
  sentinelChanges,
  verifierChanges,
  type AgentsDeps,
  type RulesPrCache,
} from "./agents";
import { parseAgentConfig, pushRefusal } from "./agents-adapter";
import { SENTINEL_RULE_DEFAULTS, VERIFIER_RULE_DEFAULTS, type RosterPrView } from "./contracts";

describe("what a rules save changes", () => {
  it("compares the sentinel's rules with the base branch's, defaults filled on both sides", () => {
    expect(sentinelChanges({ lookbackHours: 48 }, { ...SENTINEL_RULE_DEFAULTS, lookbackHours: 48, mode: "file" })).toEqual([
      { key: "mode", from: "observe", to: "file" },
    ]);
    // Spelling out a default the block left implicit is no change.
    expect(sentinelChanges(null, { ...SENTINEL_RULE_DEFAULTS })).toEqual([]);
  });

  it("names a nested verifier rule by its path and compares lists by value", () => {
    const after = { ...VERIFIER_RULE_DEFAULTS, checkIns: [1, 12], revert: { ...VERIFIER_RULE_DEFAULTS.revert, minUsers: 4 } };
    expect(verifierChanges({ windowHours: 24 }, after)).toEqual([
      { key: "checkIns", from: [1, 6, 24], to: [1, 12] },
      { key: "revert.minUsers", from: 2, to: 4 },
    ]);
    expect(verifierChanges(null, { ...VERIFIER_RULE_DEFAULTS, checkIns: [1, 6, 24] })).toEqual([]);
  });
});

describe("rulesCommitMessage", () => {
  it("spells one change out in the subject", () => {
    const { subject, message } = rulesCommitMessage("sentinel", [{ key: "mode", from: "observe", to: "file" }]);
    expect(subject).toBe("ralph: sentinel rules — mode observe → file");
    expect(message.split("\n")[0]).toBe(subject);
    expect(message).toContain("- mode observe → file");
  });

  it("names several changes by key in the subject and lists each in the body", () => {
    const { subject, message } = rulesCommitMessage("verifier", [
      { key: "mode", from: "observe", to: "report" },
      { key: "checkIns", from: [1, 6, 24], to: [1, 12] },
      { key: "revert.minUsers", from: 2, to: 4 },
    ]);
    expect(subject).toBe("ralph: verifier rules — mode, checkIns and revert.minUsers");
    expect(message.split("\n").slice(1)).toEqual([
      "",
      "Saved from the dashboard's Verifier sheet. Changes only these `verifier` rules in `.ralph/config.json`:",
      "",
      "- mode observe → report",
      "- checkIns [1, 6, 24] → [1, 12]",
      "- revert.minUsers 2 → 4",
    ]);
  });
});

describe("pushRefusal", () => {
  it("reads why from the line that says it, not from `To <remote>`", () => {
    expect(
      pushRefusal(
        [
          "remote: error: GH006: Protected branch update failed for refs/heads/main.",
          "remote: error: Changes must be made through a pull request.",
          "To github.com:o/r.git",
          " ! [remote rejected] abc -> main (protected branch hook declined)",
        ].join("\n"),
      ),
    ).toBe("the branch is protected");
    expect(pushRefusal("To /tmp/origin.git\n ! [rejected]        abc -> main (fetch first)\nerror: failed to push some refs\n")).toBe(
      "fetch first: the branch moved since it was fetched",
    );
    expect(pushRefusal("To /tmp/origin.git\n ! [rejected]        abc -> main (non-fast-forward)\n")).toBe(
      "non-fast-forward: the branch moved since it was fetched",
    );
    expect(pushRefusal("To /tmp/origin.git\n ! [remote rejected] abc -> main (pre-receive hook declined)\n")).toBe("pre-receive hook declined");
    expect(pushRefusal("fatal: unable to access 'https://github.com/o/r/': Could not resolve host\n")).toBeNull();
  });
});

describe("the config read's configChanges", () => {
  const read = (extra: object) => parseAgentConfig({ status: 0, stdout: JSON.stringify({ repo: "o/r", baseBranch: "main", loops: [], ...extra }), stderr: "" });
  it("is commit unless the config spells pr", () => {
    expect(read({})).toMatchObject({ ok: true, value: { configChanges: "commit" } });
    expect(read({ configChanges: "commit" })).toMatchObject({ ok: true, value: { configChanges: "commit" } });
    expect(read({ configChanges: "pr" })).toMatchObject({ ok: true, value: { configChanges: "pr" } });
  });
});

interface RulesFake {
  configChanges?: "commit" | "pr";
  /** Why the push to the base branch is refused; it lands when unset. */
  baseRefused?: string;
  /** The open rules PR the fallback finds. */
  open?: RosterPrView;
  /** Why the open-PR lookup fails; it answers when unset. */
  openFails?: string;
  prFails?: boolean;
}

const BASE_SENTINEL = { reporter: { kind: "sentry", org: "o", project: "p" }, mode: "observe" };
const BASE_VERIFIER = { productionUrl: "https://p.example.com", deploy: { source: "vercel" }, sentry: { org: "o", project: "p" } };

/** An adapter whose every step answers in place, recording the commits made and the pushes tried. */
function rulesDeps(fake: RulesFake = {}) {
  const calls: string[] = [];
  const config = {
    repo: "o/r",
    baseBranch: "main",
    loops: ["sent"],
    roster: [{ name: "sent", role: "sentinel" }],
    sentinel: BASE_SENTINEL,
    verifier: BASE_VERIFIER,
    ...(fake.configChanges === undefined ? {} : { configChanges: fake.configChanges }),
  };
  const done = <T>(value: T) => Promise.resolve({ ok: true as const, value });
  const agents = {
    readConfig: () => Promise.resolve(parseAgentConfig({ status: 0, stdout: JSON.stringify(config), stderr: "" })),
    fetch: () => {
      calls.push("fetch");
      return Promise.resolve({ ok: true });
    },
    sentinelPr: () => {
      calls.push("open?");
      return fake.openFails === undefined ? done(fake.open ?? null) : Promise.resolve({ ok: false, why: fake.openFails });
    },
    verifierPr: () => {
      calls.push("open?");
      return fake.openFails === undefined ? done(fake.open ?? null) : Promise.resolve({ ok: false, why: fake.openFails });
    },
    sentinelBranch: (stamp: string) => `ralph-roster/sentinel-rules-${stamp}`,
    verifierBranch: (stamp: string) => `ralph-roster/verifier-rules-${stamp}`,
    editSentinel: () => done("{}\n"),
    editVerifier: () => done("{}\n"),
    stage: () => ({ index: "/tmp/i", file: "/tmp/f", dispose: () => {} }),
    readTree: () => done(""),
    hashObject: () => done("b"),
    updateIndex: () => done(""),
    writeTree: () => done("t"),
    commitTree: (_staged: unknown, _tree: string, parent: string, message: string) => {
      calls.push(`commit on ${parent}: ${message.split("\n")[0]}`);
      return done("c0ffee1234567");
    },
    push: (commit: string, branch: string) => {
      calls.push(`push ${commit} ${branch.startsWith("ralph-roster/") ? "rules-branch" : branch}`);
      if (branch === "main" && fake.baseRefused !== undefined) return Promise.resolve({ ok: false, why: fake.baseRefused });
      return done("");
    },
    createPr: () => {
      calls.push("pr");
      return fake.prFails === true ? Promise.resolve({ ok: false, why: "HTTP 502" }) : done("https://github.com/o/r/pull/9\n");
    },
  } as unknown as AgentsDeps["agents"];
  return { deps: { agents } as AgentsDeps, calls };
}

const FILE = { ...SENTINEL_RULE_DEFAULTS, mode: "file" };

describe("a rules save", () => {
  it("commits onto the fetched base and pushes it to the base branch, opening no PR", async () => {
    const { deps, calls } = rulesDeps();
    expect(await proposeSentinel(deps, FILE)).toEqual({
      outcome: "committed",
      commit: { branch: "main", sha: "c0ffee1234567", subject: "ralph: sentinel rules — mode observe → file" },
    });
    // A direct commit does not wait on an open rules PR: nothing asks.
    expect(calls).toEqual(["fetch", "commit on origin/main: ralph: sentinel rules — mode observe → file", "push c0ffee1234567 main"]);
  });

  it("falls back to a rules PR of the same commit when the push is refused, and says why", async () => {
    const { deps, calls } = rulesDeps({ baseRefused: "the branch is protected" });
    const result = await proposeSentinel(deps, FILE);
    expect(result).toMatchObject({ outcome: "proposed", notCommitted: "the branch is protected", pr: { url: "https://github.com/o/r/pull/9" } });
    expect(calls.slice(2)).toEqual(["push c0ffee1234567 main", "open?", "push c0ffee1234567 rules-branch", "pr"]);
  });

  it("keeps one rules PR at a time on the fallback", async () => {
    const open = { url: "https://github.com/o/r/pull/3", branch: "ralph-roster/sentinel-rules-x", state: "open" as const };
    const { deps, calls } = rulesDeps({ baseRefused: "fetch first: the branch moved since it was fetched", open });
    const result = await proposeSentinel(deps, FILE);
    expect(result).toEqual({ outcome: "refused", why: expect.stringContaining(open.url) });
    expect(result.outcome === "refused" ? result.why : "").toContain("fetch first");
    expect(calls.filter((call) => call.startsWith("push"))).toEqual(["push c0ffee1234567 main"]);
  });

  it("answers pr-failed with both reasons when the fallback PR cannot be opened either", async () => {
    const { deps } = rulesDeps({ baseRefused: "git push did not exit (killed, timed out or never started)", prFails: true });
    const result = await proposeVerifier(deps, { ...VERIFIER_RULE_DEFAULTS, mode: "report" });
    expect(result.outcome).toBe("pr-failed");
    expect(result.outcome === "pr-failed" ? result.why : "").toMatch(/did not exit.*HTTP 502/);
  });

  it("refuses a save that changes nothing rather than commit it", async () => {
    const { deps, calls } = rulesDeps();
    expect(await proposeSentinel(deps, { ...SENTINEL_RULE_DEFAULTS })).toEqual({
      outcome: "refused",
      why: "nothing to save: these are already the sentinel rules on origin/main",
    });
    expect(calls.filter((call) => call.startsWith("push") || call.startsWith("commit"))).toEqual([]);
  });

  it("with configChanges pr, asks for an open PR first and never pushes to the base branch", async () => {
    const { deps, calls } = rulesDeps({ configChanges: "pr" });
    const result = await proposeVerifier(deps, { ...VERIFIER_RULE_DEFAULTS, mode: "report" });
    expect(result).toEqual({ outcome: "proposed", pr: { url: "https://github.com/o/r/pull/9", branch: expect.any(String), state: "open" } });
    expect(calls).toEqual(["fetch", "open?", "commit on origin/main: Ralph verifier: rules", "push c0ffee1234567 rules-branch", "pr"]);
  });
});

describe("the rules-PR cache", () => {
  const OPEN = { url: "https://github.com/o/r/pull/3", branch: "ralph-roster/sentinel-rules-x", state: "open" as const };
  /** Deps over the fake, with a cache on an injected clock. */
  const cached = (fake: RulesFake) => {
    const clock = { at: 1_000 };
    const rulesPrs: RulesPrCache = { now: () => clock.at, entries: new Map() };
    const { deps, calls } = rulesDeps(fake);
    return { deps: { ...deps, rulesPrs } as AgentsDeps, calls, clock };
  };
  const lookups = (calls: readonly string[]) => calls.filter((call) => call === "open?").length;

  it("answers the sentinel's pending PR from the cache within the TTL, and asks again after it", async () => {
    const fake: RulesFake = { open: OPEN };
    const { deps, calls, clock } = cached(fake);
    expect(await readSentinel(deps)).toMatchObject({ ok: true, value: { pending: OPEN } });
    clock.at += RULES_PR_TTL_MS - 1;
    // Closed outside the dashboard: the cache still answers it until the TTL runs out.
    delete fake.open;
    expect(await readSentinel(deps)).toMatchObject({ ok: true, value: { pending: OPEN } });
    expect(lookups(calls)).toBe(1);
    clock.at += 1;
    expect(await readSentinel(deps)).toMatchObject({ ok: true, value: { pending: null } });
    expect(lookups(calls)).toBe(2);
  });

  it("caches the verifier's lookup apart from the sentinel's", async () => {
    const { deps, calls } = cached({ open: OPEN });
    await readSentinel(deps);
    expect(await readVerifier(deps)).toMatchObject({ ok: true, value: { pending: OPEN } });
    await readVerifier(deps);
    expect(lookups(calls)).toBe(2);
  });

  it("without a cache, asks on every read", async () => {
    const { deps, calls } = rulesDeps({ open: OPEN });
    await readSentinel(deps);
    await readSentinel(deps);
    await readVerifier(deps);
    expect(lookups(calls)).toBe(3);
  });

  it("never caches a failed lookup, which still answers no pending PR", async () => {
    const fake: RulesFake = { openFails: "HTTP 502" };
    const { deps, calls } = cached(fake);
    expect(await readSentinel(deps)).toMatchObject({ ok: true, value: { pending: null } });
    delete fake.openFails;
    fake.open = OPEN;
    expect(await readSentinel(deps)).toMatchObject({ ok: true, value: { pending: OPEN } });
    expect(lookups(calls)).toBe(2);
  });

  it("skips the lookup on pending skip, with the rules intact", async () => {
    const { deps, calls } = cached({ open: OPEN });
    const sentinel = await readSentinel(deps, { pending: "skip" });
    const verifier = await readVerifier(deps, { pending: "skip" });
    expect(lookups(calls)).toBe(0);
    // Everything but the pending PR is what a full read answers.
    const fullSentinel = await readSentinel(rulesDeps({ open: OPEN }).deps);
    const fullVerifier = await readVerifier(rulesDeps({ open: OPEN }).deps);
    expect(sentinel).toEqual({ ok: true, value: { ...(fullSentinel.ok ? fullSentinel.value : {}), pending: null } });
    expect(verifier).toEqual({ ok: true, value: { ...(fullVerifier.ok ? fullVerifier.value : {}), pending: null } });
    expect(sentinel).toMatchObject({ value: { rostered: true, configured: true, rules: { mode: "observe" } } });
  });

  it("shows a proposed PR on the next read without a new lookup", async () => {
    const { deps, calls } = cached({ configChanges: "pr" });
    expect(await readSentinel(deps)).toMatchObject({ ok: true, value: { pending: null } });
    const result = await proposeSentinel(deps, FILE);
    expect(result).toMatchObject({ outcome: "proposed", pr: { url: "https://github.com/o/r/pull/9" } });
    const before = lookups(calls);
    expect(await readSentinel(deps)).toMatchObject({ ok: true, value: { pending: { url: "https://github.com/o/r/pull/9", state: "open" } } });
    expect(lookups(calls)).toBe(before);
  });

  it("shows a fallback PR on the next read too", async () => {
    const { deps, calls } = cached({ baseRefused: "the branch is protected" });
    expect(await proposeVerifier(deps, { ...VERIFIER_RULE_DEFAULTS, mode: "report" })).toMatchObject({ outcome: "proposed" });
    const before = lookups(calls);
    expect(await readVerifier(deps)).toMatchObject({ ok: true, value: { pending: { url: "https://github.com/o/r/pull/9" } } });
    expect(lookups(calls)).toBe(before);
  });

  it("never lets a slow lookup overwrite what a save wrote while it ran", async () => {
    const { deps, clock } = cached({});
    const opened = { ...OPEN, url: "https://github.com/o/r/pull/9" };
    // The list was asked before the save opened its PR, and answers after it.
    const agents = {
      ...deps.agents,
      sentinelPr: async () => {
        clock.at += 10;
        deps.rulesPrs!.entries.set(`sentinel\u0000o/r`, { value: opened, at: clock.at });
        return { ok: true as const, value: null };
      },
    };
    expect(await readSentinel({ ...deps, agents })).toMatchObject({ ok: true, value: { pending: null } });
    expect(await readSentinel(deps)).toMatchObject({ ok: true, value: { pending: opened } });
  });

  it("does not let a stale cached none bypass the already-open refusal", async () => {
    const fake: RulesFake = { configChanges: "pr" };
    const { deps } = cached(fake);
    expect(await readSentinel(deps)).toMatchObject({ ok: true, value: { pending: null } });
    // Opened outside the dashboard, within the TTL: the save still reads fresh.
    fake.open = OPEN;
    expect(await proposeSentinel(deps, FILE)).toEqual({ outcome: "refused", why: expect.stringContaining(OPEN.url) });
    // And the fresh read refreshed the cache.
    expect(await readSentinel(deps)).toMatchObject({ ok: true, value: { pending: OPEN } });
  });
});
