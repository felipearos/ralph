import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { applySteps, issueNumberOf, restoreBodies, type ApplyContext, type GhResult, type IssueState } from "./apply";
import { parseStaffingGroup } from "../frontier/next-tasks";
import { readLedger } from "./ledger";
import { orderOps } from "./order";
import type { TriageOp, TriagePlan } from "./plan";

const scratchRoots: string[] = [];
const ledgerFile = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `ralph-${label}-`));
  scratchRoots.push(dir);
  return join(dir, "triage-apply-100.jsonl");
};
afterAll(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

const plan = (ops: TriageOp[]): TriagePlan => ({
  unit: 100,
  loop: "tessa",
  attempt: 1,
  outcome: "routed",
  ops,
});

interface Recorder {
  calls: string[][];
  sleeps: number[];
  answers: (args: string[]) => GhResult;
}

const ok = (stdout = ""): GhResult => ({ ok: true, stdout, stderr: "" });

const harness = (
  plan: TriagePlan,
  state: Map<number, IssueState>,
  answers: Recorder["answers"] = () => ok(),
  ledger = ledgerFile("apply"),
): { context: ApplyContext; calls: string[][]; sleeps: number[] } => {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  return {
    calls,
    sleeps,
    context: {
      plan,
      steps: orderOps(plan),
      ledger,
      spacingMs: 1500,
      state,
      io: {
        gh: async (args) => {
          calls.push(args);
          return answers(args);
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        now: () => "2026-09-30T00:00:00Z",
      },
    },
  };
};

const stateOf = (labels: string[] = [], body = "## What to build\n\nthings\n"): Map<number, IssueState> =>
  new Map([[100, { body, labels: new Set(labels) }]]);

describe("applySteps — pacing", () => {
  it("spaces the writes by the configured gap, and does not sleep before the first", async () => {
    const { context, sleeps } = harness(
      plan([
        { op: "add-label", opId: "a1", issue: 100, label: "needs-info" },
        { op: "comment", opId: "c1", issue: 100, body: "asked" },
      ]),
      stateOf(),
    );
    const report = await applySteps(context);
    expect(report.outcome).toBe("applied");
    expect(sleeps).toEqual([1500]);
  });
});

describe("applySteps — rate limits", () => {
  it("stops at once on a 403 secondary limit and reports rateLimited", async () => {
    const { context, calls } = harness(
      plan([
        { op: "add-label", opId: "a1", issue: 100, label: "needs-info" },
        { op: "add-label", opId: "a2", issue: 100, label: "duplicate" },
      ]),
      stateOf(),
      (args) =>
        args.includes("duplicate")
          ? { ok: false, stdout: "", stderr: "HTTP 403: You have exceeded a secondary rate limit" }
          : ok(),
    );
    const report = await applySteps(context);
    expect(report.outcome).toBe("rate-limited");
    expect(report.rateLimit?.kind).toBe("secondary");
    expect(report.problem).toContain("stopped at a2");
    expect(report.performed).toBe(1);
    // Nothing after the refused write was attempted.
    expect(calls.filter((call) => call[0] === "issue")).toHaveLength(2);
  });

  it("reports an ordinary failure as failed, not as a rate limit", async () => {
    const { context } = harness(
      plan([{ op: "add-label", opId: "a1", issue: 100, label: "needs-info" }]),
      stateOf(),
      () => ({ ok: false, stdout: "", stderr: "HTTP 404: Not Found" }),
    );
    const report = await applySteps(context);
    expect(report.outcome).toBe("failed");
    expect(report.rateLimit).toBeNull();
  });
});

describe("applySteps — idempotency", () => {
  it("makes zero writes when every op is already in the ledger", async () => {
    const ledger = ledgerFile("apply-rerun");
    const ops: TriageOp[] = [
      { op: "add-label", opId: "a1", issue: 100, label: "needs-info" },
      { op: "comment", opId: "c1", issue: 100, body: "asked" },
    ];
    const first = harness(plan(ops), stateOf(), () => ok(), ledger);
    await applySteps(first.context);
    expect(first.calls.filter((call) => call[0] === "issue" && call[1] !== "view")).not.toHaveLength(0);

    const again = harness(plan(ops), stateOf(), () => ok(), ledger);
    const report = await applySteps(again.context);
    expect(again.calls).toEqual([]);
    expect(report.performed).toBe(0);
    expect(report.skipped).toBe(2);
  });

  it("resumes after a kill at the k-th write and reaches the same state", async () => {
    const ledger = ledgerFile("apply-resume");
    const ops: TriageOp[] = [
      { op: "add-label", opId: "a1", issue: 100, label: "needs-info" },
      { op: "add-label", opId: "a2", issue: 100, label: "duplicate" },
      { op: "comment", opId: "c1", issue: 100, body: "asked" },
    ];
    const killed = harness(
      plan(ops),
      stateOf(),
      (args) => (args.includes("duplicate") ? { ok: false, stdout: "", stderr: "HTTP 500" } : ok()),
      ledger,
    );
    await applySteps(killed.context);
    expect(readLedger(ledger).map((line) => line.opId)).toEqual(["a1"]);

    const resumed = harness(plan(ops), stateOf(["needs-info"]), () => ok(), ledger);
    const report = await applySteps(resumed.context);
    expect(report.outcome).toBe("applied");
    // a1 is skipped by the ledger; a2 and the comment are the only writes left.
    expect(resumed.calls.map((call) => call.slice(0, 2))).toEqual([
      ["issue", "edit"],
      ["issue", "view"],
      ["issue", "comment"],
    ]);
  });

  it("does not repost a comment GitHub already carries with that op id", async () => {
    const { context, calls } = harness(
      plan([{ op: "comment", opId: "c1", issue: 100, body: "asked" }]),
      stateOf(),
      (args) => (args[1] === "view" ? ok("earlier text <!-- ralph:triage-op id=c1 -->") : ok()),
    );
    const report = await applySteps(context);
    expect(report.skipped).toBe(1);
    expect(calls.some((call) => call[1] === "comment")).toBe(false);
  });

  it("skips a label the issue already carries and a removal of one it does not", async () => {
    const { context, calls } = harness(
      plan([
        { op: "add-label", opId: "a1", issue: 100, label: "needs-info" },
        { op: "remove-label", opId: "a2", issue: 100, label: "duplicate" },
      ]),
      stateOf(["needs-info"]),
    );
    const report = await applySteps(context);
    expect(calls).toEqual([]);
    expect(report.skipped).toBe(2);
  });

  it("skips a section edit on a CRLF body, which GitHub's editor produces", async () => {
    const body = "## Staffing group\r\n\r\ncli\r\n";
    const { context, calls } = harness(
      plan([{ op: "set-section", opId: "s1", issue: 100, heading: "Staffing group", mode: "replace", body: "cli" }]),
      stateOf([], body),
    );
    await applySteps(context);
    expect(calls).toEqual([]);
  });

  it("skips a section edit whose result is the body already there", async () => {
    const body = "## Staffing group\n\ncli\n";
    const { context, calls } = harness(
      plan([{ op: "set-section", opId: "s1", issue: 100, heading: "Staffing group", mode: "replace", body: "cli" }]),
      stateOf([], body),
    );
    await applySteps(context);
    expect(calls).toEqual([]);
  });

  it("does not re-close an issue GitHub already has closed, with no ledger to say so", async () => {
    const { context, calls } = harness(
      plan([
        {
          op: "close",
          opId: "x1",
          issue: 100,
          evidence: { kind: "done-in", pr: 9, criteria: [{ criterion: "AC 1", cite: "a.ts" }] },
        },
      ]),
      stateOf(),
      (args) => (args[1] === "view" ? ok("CLOSED\n") : ok()),
    );
    const report = await applySteps(context);
    expect(report.skipped).toBe(1);
    expect(calls.some((call) => call[1] === "close")).toBe(false);
  });

  it("does not re-add a dependency GitHub already records, with no ledger to say so", async () => {
    const { context, calls } = harness(
      plan([{ op: "add-blocker", opId: "b1", issue: 100, blockedBy: 77 }]),
      stateOf(),
      (args) => (args[0] === "api" ? ok("[77]") : ok()),
    );
    const report = await applySteps(context);
    expect(report.skipped).toBe(1);
    expect(calls.some((call) => call.includes("--method"))).toBe(false);
  });

  it("posts a new dependency with -F so gh sends issue_id as a number", async () => {
    const { context, calls } = harness(
      plan([{ op: "add-blocker", opId: "b1", issue: 100, blockedBy: 77 }]),
      stateOf(),
      (args) => {
        if (args[0] !== "api" || args.includes("--method")) return ok();
        return args[1]?.endsWith("/dependencies/blocked_by") ? ok("[]") : ok("6320906609\n");
      },
    );
    const report = await applySteps(context);
    expect(report.outcome).toBe("applied");
    expect(report.performed).toBe(1);
    const post = calls.find((call) => call.includes("--method"))!;
    expect(post).toEqual([
      "api",
      "--method",
      "POST",
      "repos/{owner}/{repo}/issues/100/dependencies/blocked_by",
      "-F",
      "issue_id=6320906609",
    ]);
    // `-f` would send the id as a string, and GitHub refuses that with a 422.
    expect(post).not.toContain("-f");
  });

  it("resolves an add-blocker's ref to the issue a create-issue op made in the same apply", async () => {
    const { context, calls } = harness(
      plan([
        { op: "create-issue", opId: "n1", ref: "child", title: "First slice", body: "## Parent\n\n#100\n" },
        { op: "add-blocker", opId: "b1", issue: 100, blockedBy: "child" },
      ]),
      stateOf(),
      (args) => {
        if (args[1] === "list") return ok("[]");
        if (args[1] === "create") return ok("https://github.com/o/r/issues/412\n");
        if (args[0] !== "api" || args.includes("--method")) return ok();
        if (args[1]?.endsWith("/dependencies/blocked_by")) return ok("[]");
        return args[1] === "repos/{owner}/{repo}/issues/412" ? ok("9000412\n") : ok("wrong-issue\n");
      },
    );
    const report = await applySteps(context);
    expect(report.created.get("child")).toBe(412);
    expect(calls.findIndex((call) => call[1] === "create")).toBeLessThan(
      calls.findIndex((call) => call.includes("--method")),
    );
    const post = calls.find((call) => call.includes("--method"))!;
    expect(post).toContain("repos/{owner}/{repo}/issues/100/dependencies/blocked_by");
    expect(post.slice(-2)).toEqual(["-F", "issue_id=9000412"]);
  });

  it("reuses an issue an earlier run created rather than creating a second", async () => {
    const { context, calls } = harness(
      plan([{ op: "create-issue", opId: "n1", ref: "child", title: "First slice", body: "## Parent\n\n#100\n" }]),
      stateOf(),
      (args) =>
        args[1] === "list" ? ok('[{"number":412,"body":"x <!-- ralph:triage-op id=n1 -->"}]') : ok(),
    );
    const report = await applySteps(context);
    expect(calls.some((call) => call[1] === "create")).toBe(false);
    expect(report.created.get("child")).toBe(412);
  });
});

describe("applySteps — writes", () => {
  it("creates an issue, records its number, and resolves a deferred ready label against it", async () => {
    const { context, calls } = harness(
      plan([
        {
          op: "create-issue",
          opId: "n1",
          ref: "child",
          title: "First slice",
          body: "## Parent\n\n#100\n",
          labels: ["ready-for-agent", "jav-2"],
        },
      ]),
      stateOf(),
      (args) =>
        args[1] === "list" ? ok("[]") : args[1] === "create" ? ok("https://github.com/o/r/issues/412\n") : ok(),
    );
    const report = await applySteps(context);
    expect(report.created.get("child")).toBe(412);

    const create = calls.find((call) => call[1] === "create")!;
    expect(create).toContain("--label");
    expect(create).toContain("jav-2");
    expect(create).not.toContain("ready-for-agent");
    const promote = calls.find((call) => call[1] === "edit" && call.includes("ready-for-agent"))!;
    expect(promote).toEqual(["issue", "edit", "412", "--add-label", "ready-for-agent"]);
  });

  it("posts a created body with its marker at the TOP, where no section holds it", async () => {
    const { context, calls } = harness(
      plan([
        {
          op: "create-issue",
          opId: "n1",
          ref: "child",
          title: "First slice",
          body: "## Parent\n\n#100\n\n## Staffing group\n\ncli\n",
        },
      ]),
      stateOf(),
      (args) => (args[1] === "list" ? ok("[]") : ok("https://github.com/o/r/issues/412\n")),
    );
    await applySteps(context);
    const create = calls.find((call) => call[1] === "create")!;
    const body = create[create.indexOf("--body") + 1]!;
    expect(body.startsWith("<!-- ralph:triage-op id=n1 -->")).toBe(true);
    expect(parseStaffingGroup(body)).toBe("cli");
  });

  it("marks a comment with its op id so a rerun can find it", async () => {
    const { context, calls } = harness(
      plan([{ op: "comment", opId: "c1", issue: 100, body: "asked" }]),
      stateOf(),
    );
    await applySteps(context);
    const comment = calls.find((call) => call[1] === "comment")!;
    expect(comment[4]).toBe("asked\n\n<!-- ralph:triage-op id=c1 -->");
  });

  it("closes a duplicate as not planned, labelled, and a done-in as completed", async () => {
    const duplicate = harness(
      plan([{ op: "close", opId: "x1", issue: 100, evidence: { kind: "duplicate-of", issue: 7 } }]),
      stateOf(),
    );
    await applySteps(duplicate.context);
    expect(duplicate.calls[0]).toEqual(["issue", "view", "100", "--json", "state", "--jq", ".state"]);
    expect(duplicate.calls[1]).toEqual(["issue", "edit", "100", "--add-label", "duplicate"]);
    expect(duplicate.calls[2]).toEqual(["issue", "close", "100", "--reason", "not planned"]);

    const done = harness(
      plan([
        {
          op: "close",
          opId: "x1",
          issue: 100,
          evidence: { kind: "done-in", pr: 9, criteria: [{ criterion: "AC 1", cite: "a.ts" }] },
        },
      ]),
      stateOf(),
    );
    await applySteps(done.context);
    expect(done.calls[1]).toEqual(["issue", "close", "100"]);
  });

  it("keeps a before-image of every body it edits, once per issue", async () => {
    const body = "## What to build\n\nthings\n";
    const { context } = harness(
      plan([
        { op: "set-section", opId: "s1", issue: 100, heading: "Staffing group", mode: "replace", body: "cli" },
        { op: "set-section", opId: "s2", issue: 100, heading: "Parent", mode: "replace", body: "#4" },
      ]),
      stateOf([], body),
    );
    const report = await applySteps(context);
    expect([...report.beforeImages]).toEqual([[100, body]]);
  });
});

describe("restoreBodies", () => {
  it("puts every changed body back, paced, and reports what would not restore", async () => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    const result = await restoreBodies(new Map([[100, "old one"], [101, "old two"]]), {
      spacingMs: 1500,
      io: {
        gh: async (args) => {
          calls.push(args);
          return args[2] === "101" ? { ok: false, stdout: "", stderr: "HTTP 500" } : ok();
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        now: () => "2026-09-30T00:00:00Z",
      },
    });
    expect(result).toEqual({ restored: [100], failed: [101] });
    expect(calls[0]).toEqual(["issue", "edit", "100", "--body", "old one"]);
    expect(sleeps).toEqual([1500]);
  });
});

describe("issueNumberOf", () => {
  it("reads the number off the URL gh prints, and nothing else", () => {
    expect(issueNumberOf("https://github.com/o/r/issues/412\n")).toBe(412);
    expect(issueNumberOf("something went wrong")).toBeNull();
  });
});

describe("applySteps — unblock", () => {
  it("removes the coder's block label, after the comment that explains it", async () => {
    const { context, calls } = harness(
      plan([
        { op: "unblock", opId: "u1", issue: 100, label: "rafa-blocked" },
        { op: "comment", opId: "c1", issue: 100, body: "unblocked: rescue count for rafa reset" },
      ]),
      stateOf(["ready-for-agent", "rafa-blocked"]),
      (args) => ok(args[1] === "comment" ? "https://github.com/o/r/issues/100#issuecomment-1" : ""),
    );
    const report = await applySteps(context);

    expect(report.outcome).toBe("applied");
    // The lookup before the comment is `alreadyCommented`'s; the two WRITES are
    // what the order matters for.
    const writes = calls.filter((args) => args[1] === "comment" || args[1] === "edit");
    expect(writes.map((args) => args[1])).toEqual(["comment", "edit"]);
    expect(writes[1]).toEqual(["issue", "edit", "100", "--remove-label", "rafa-blocked"]);
    expect(context.state.get(100)!.labels.has("rafa-blocked")).toBe(false);
  });

  it("skips an unblock whose label is already gone, and writes nothing", async () => {
    const { context, calls } = harness(
      plan([{ op: "unblock", opId: "u1", issue: 100, label: "rafa-blocked" }]),
      stateOf(["ready-for-agent"]),
    );
    const report = await applySteps(context);

    expect(calls).toEqual([]);
    expect(report.skipped).toBe(1);
    expect(readLedger(context.ledger)[0]).toMatchObject({ op: "unblock", result: "skipped" });
  });

  it("records the unblock in the ledger under its own op name, so a replay skips it", async () => {
    const ledger = ledgerFile("unblock-replay");
    const ops: TriageOp[] = [{ op: "unblock", opId: "u1", issue: 100, label: "rafa-blocked" }];
    const first = harness(plan(ops), stateOf(["rafa-blocked"]), () => ok(), ledger);
    await applySteps(first.context);
    expect(readLedger(ledger)[0]).toMatchObject({ op: "unblock", result: "applied" });

    const again = harness(plan(ops), stateOf(["rafa-blocked"]), () => ok(), ledger);
    const report = await applySteps(again.context);
    expect(again.calls).toEqual([]);
    expect(report.performed).toBe(0);
  });
});
