// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupFixtures, scratchProject } from "./dashboard/fixtures";
import { subprocessSuite } from "./test-timeouts";
import { EXIT, allowedLabelsFor, frontierVerdict, parseFlags, release, writeSpacingMs } from "./triage-apply";
import type { ApplyIo, GhResult } from "./triage/apply";
import {
  UNBLOCK_MARKER_OP,
  formatTriageMarker,
  triageBodyHash,
  unblockLead,
} from "./triage-marker";

// The scratch projects this file registers with the fixtures; nothing drains
// them unless the suite says so (#271).
afterAll(cleanupFixtures);

subprocessSuite("runs the triage-apply CLI through bun with a fake gh");

const SCRIPT = join(import.meta.dirname, "triage-apply.ts");
const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();

const fakeBinDir = mkdtempSync(join(tmpdir(), "ralph-triage-apply-"));
writeFileSync(
  join(fakeBinDir, "gh"),
  [
    "#!/bin/sh",
    "# Fake gh: records argv, answers an EMPTY backlog for every read, and would",
    "# record any write the tool attempted — which is what the refusal tests assert.",
    // One line per call: a `--body` carries newlines, and recording them raw
    // would split one call across several lines of the log.
    'printf \'%s\\n\' "$(printf \'%s\' "$*" | tr \'\\n\' \' \')" >> "$FAKE_DIR/argv"',
    'case "$1 $2" in',
    // A census and a label list the case may supply, so one script serves both
    // the refusal tests (an empty backlog) and the rescue walk-through.
    '  "api graphql") if [ -f "$FAKE_DIR/census.json" ]; then cat "$FAKE_DIR/census.json"; else echo \'{"data":{"repository":{"issues":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}\'; fi ;;',
    '  "label list") if [ -f "$FAKE_DIR/labels.json" ]; then cat "$FAKE_DIR/labels.json"; else echo \'[]\'; fi ;;',
    '  "issue comment") echo "https://github.com/o/r/issues/12#issuecomment-1" ;;',
    // The rescue rules read a ticket's comments in FULL, past the census tail.
    '  "issue view") case "$*" in',
    '      *"--json comments"*) if [ -f "$FAKE_DIR/comments.json" ]; then cat "$FAKE_DIR/comments.json"; else echo \'{"comments":[]}\'; fi ;;',
    "      *) echo '[]' ;;",
    '    esac ;;',
    "  *) echo '[]' ;;",
    "esac",
    "",
  ].join("\n"),
);
chmodSync(join(fakeBinDir, "gh"), 0o755);

afterAll(() => rmSync(fakeBinDir, { recursive: true, force: true }));

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Every `gh` invocation the run made, in order. */
  gh: string[];
}

const WRITE = /^(issue (edit|comment|create|close)|api --method)/;

function runCli(
  plan: unknown,
  args: string[] = [],
  world: {
    census?: unknown;
    labels?: string[];
    /** What `gh issue view --json comments` answers; the rescue cap reads it. */
    comments?: { body: string; createdAt: string }[];
    env?: Record<string, string>;
    /** The project's `tracker` block; GitHub issues when absent. */
    tracker?: unknown;
  } = {},
): Run {
  const dir = mkdtempSync(join(fakeBinDir, "case-"));
  const root = scratchProject("triage-apply");
  if (world.tracker !== undefined) {
    const configPath = join(root, ".ralph", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, tracker: world.tracker }));
  }
  const planPath = join(dir, "triage-plan-12.json");
  writeFileSync(planPath, typeof plan === "string" ? plan : JSON.stringify(plan));
  if (world.census !== undefined) writeFileSync(join(dir, "census.json"), JSON.stringify(world.census));
  if (world.labels !== undefined) {
    writeFileSync(join(dir, "labels.json"), JSON.stringify(world.labels.map((name) => ({ name }))));
  }
  if (world.comments !== undefined) {
    writeFileSync(join(dir, "comments.json"), JSON.stringify({ comments: world.comments }));
  }
  const result = spawnSync(BUN, [SCRIPT, "--plan", planPath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      FAKE_DIR: dir,
      RALPH_PROJECT: root,
      ...world.env,
    },
  });
  const argvFile = join(dir, "argv");
  const gh = existsSync(argvFile)
    ? readFileSync(argvFile, "utf8").trim().split("\n").filter((line) => line !== "")
    : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, gh };
}

const validShape = {
  unit: 12,
  loop: "ralph",
  attempt: 1,
  outcome: "routed",
  ops: [{ op: "add-label", opId: "a1", issue: 12, label: "ready-for-agent" }],
};

describe("parseFlags", () => {
  it("requires a plan and reads the two switches", () => {
    expect(parseFlags([])).toEqual({ problem: "--plan is required" });
    expect(parseFlags(["--plan"])).toEqual({ problem: "--plan needs a file" });
    expect(parseFlags(["--plan", "--json"])).toEqual({ problem: "--plan needs a file" });
    expect(parseFlags(["--wat"])).toEqual({ problem: "unknown argument --wat" });
    expect(parseFlags(["--plan", "p.json", "--dry-run", "--json"])).toEqual({
      flags: { plan: "p.json", dryRun: true, json: true },
    });
  });
});

describe("writeSpacingMs", () => {
  it("defaults to 1500ms and takes an integer override", () => {
    expect(writeSpacingMs({})).toBe(1500);
    expect(writeSpacingMs({ RALPH_TRIAGE_WRITE_SPACING_MS: "0" })).toBe(0);
    expect(writeSpacingMs({ RALPH_TRIAGE_WRITE_SPACING_MS: "3000" })).toBe(3000);
    expect(writeSpacingMs({ RALPH_TRIAGE_WRITE_SPACING_MS: "soon" })).toBe(1500);
  });
});

describe("allowedLabelsFor", () => {
  it("is the triager's vocabulary plus that loop's own claim triple, and no other loop's", () => {
    const labels = allowedLabelsFor("tessa", ["ralph", "tessa"]);
    expect(labels.has("ready-for-agent")).toBe(true);
    expect(labels.has("needs-triage")).toBe(true);
    expect(labels.has("tessa-wip")).toBe(true);
    expect(labels.has("ralph-wip")).toBe(false);
  });
});

describe("frontierVerdict", () => {
  const result = (over: Partial<GhResult> = {}): GhResult => ({ ok: false, stdout: "", stderr: "", ...over });

  it("reads a clean run as the backlog being readable", () => {
    expect(frontierVerdict(result({ ok: true }))).toBe("reads");
  });

  it("calls a real parse failure unreadable, which is the only thing worth reverting for", () => {
    expect(
      frontierVerdict(result({ stderr: '## Staffing group must contain one lowercase kebab-case name' })),
    ).toBe("unreadable");
  });

  it("does NOT revert on a throttled or unrunnable census — that says nothing about the plan", () => {
    expect(frontierVerdict(result({ stderr: "HTTP 403: You have exceeded a secondary rate limit" }))).toBe(
      "inconclusive",
    );
    expect(frontierVerdict(result({ stderr: "bun: command not found" }))).toBe("inconclusive");
    expect(frontierVerdict(result({ stderr: "fatal: not a git repository" }))).toBe("inconclusive");
  });
});

describe("release", () => {
  const plan = { unit: 12, loop: "tessa", attempt: 2, outcome: "routed" as const, ops: [] };
  const harness = (answers: (args: string[]) => GhResult) => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    const deps: ApplyIo = {
      gh: async (args) => {
        calls.push(args);
        return answers(args);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => "2026-09-30T00:00:00Z",
    };
    return { calls, sleeps, deps };
  };
  const ok = (stdout = ""): GhResult => ({ ok: true, stdout, stderr: "" });

  it("takes the claim off, paces the writes, and leaves one marker carrying the op id", async () => {
    const { calls, sleeps, deps } = harness((args) =>
      args[4] === "comments" ? ok("") : args[4] === "body" ? ok("the body") : args[4] === "labels" ? ok("spec\n") : ok(),
    );
    const problems = await release(plan, { labels: new Set(["tessa-wip"]) }, deps, 1500);
    expect(problems).toEqual([]);
    expect(calls[0]).toEqual(["issue", "edit", "12", "--remove-label", "tessa-wip"]);
    const comment = calls.find((call) => call[1] === "comment")!;
    expect(comment[4]).toContain("attempt=2");
    expect(comment[4]).toContain("op=release-2");
    expect(comment[4]).toContain("<!-- ralph:triage-op id=release-2 -->");
    expect(sleeps).toEqual([1500, 1500]);
  });

  it("posts NOTHING on a rerun that already left its marker", async () => {
    const { calls, deps } = harness((args) =>
      args[4] === "comments" ? ok("older text <!-- ralph:triage-op id=release-2 -->") : ok(),
    );
    const problems = await release(plan, null, deps, 0);
    expect(problems).toEqual([]);
    expect(calls.some((call) => call[1] === "comment")).toBe(false);
  });

  it("reports a failed claim removal rather than swallowing it", async () => {
    const { deps } = harness((args) =>
      args[1] === "edit" ? { ok: false, stdout: "", stderr: "HTTP 500" } : ok(""),
    );
    const problems = await release(plan, { labels: new Set(["tessa-wip"]) }, deps, 0);
    expect(problems[0]).toContain("could not remove tessa-wip");
  });

  it("leaves a claim it does not carry alone", async () => {
    const { calls, deps } = harness(() => ok(""));
    await release(plan, { labels: new Set() }, deps, 0);
    expect(calls.some((call) => call.includes("--remove-label"))).toBe(false);
  });
});

describe("the CLI refuses before it writes", () => {
  it("refuses a malformed plan with exit 3 and not one gh call", () => {
    const result = runCli("{not json");
    expect(result.status).toBe(EXIT.refused);
    expect(result.stderr).toContain("refused, nothing written");
    expect(result.gh).toEqual([]);
  });

  it("names every structural problem it found", () => {
    const result = runCli({ ...validShape, unit: 0, outcome: "invented" });
    expect(result.status).toBe(EXIT.refused);
    expect(result.stderr).toContain("unit:");
    expect(result.stderr).toContain("outcome:");
  });

  it("refuses an op on an issue the census does not carry, making only reads", () => {
    const result = runCli(validShape);
    expect(result.status).toBe(EXIT.refused);
    expect(result.stderr).toContain("#12 is not an open issue in this read");
    // It got as far as reading the world — so the absence of writes below is
    // the refusal working, not the census having failed before it.
    expect(result.gh.some((call) => call.startsWith("api graphql"))).toBe(true);
    expect(result.gh.filter((call) => WRITE.test(call))).toEqual([]);
  });

  it("refuses a close with no evidence, making no writes", () => {
    const result = runCli({
      ...validShape,
      ops: [{ op: "close", opId: "c1", issue: 12 }],
    });
    expect(result.status).toBe(EXIT.refused);
    expect(result.stderr).toContain("evidence: is required");
    expect(result.gh.filter((call) => WRITE.test(call))).toEqual([]);
  });

  it("refuses a plan that touches another loop's claim label, making no writes", () => {
    const result = runCli({
      ...validShape,
      ops: [{ op: "remove-label", opId: "a1", issue: 12, label: "rafa-wip" }],
    });
    expect(result.status).toBe(EXIT.refused);
    expect(result.gh.filter((call) => WRITE.test(call))).toEqual([]);
  });

  it("reports usage for a missing plan file, before anything else", () => {
    const result = spawnSync(BUN, [SCRIPT, "--plan", "/nowhere/plan.json"], { encoding: "utf8" });
    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toContain("could not read");
  });

  it("exits 69 on a keyed project whose tracker is not connected, reading nothing from GitHub", () => {
    // An empty config home: no credential, so the Linear tracker cannot be built.
    const configHome = mkdtempSync(join(fakeBinDir, "config-"));
    const result = runCli(
      {
        unit: 12,
        loop: "ralph",
        attempt: 1,
        outcome: "to-person",
        ops: [{ op: "to-person", opId: "p1", issue: 12, reason: "Falta una decisión." }],
      },
      [],
      {
        tracker: { kind: "linear", team: "AND", workspace: "exampleorg" },
        env: { XDG_CONFIG_HOME: configHome, RALPH_PROJECT_ID: "keyed-fixture" },
      },
    );
    expect(result.status).toBe(EXIT.unavailable);
    expect(result.stderr).toContain("not connected");
    expect(result.gh).toEqual([]);
  });

  it("prints the refusal as JSON when asked", () => {
    const result = runCli("{not json", ["--json"]);
    const report = JSON.parse(result.stdout) as { outcome: string; writes: number; refusals: string[] };
    expect(report.outcome).toBe("refused");
    expect(report.writes).toBe(0);
    expect(report.refusals.length).toBeGreaterThan(0);
  });
});

/**
 * felipearos/ralph#150 AC 1 and AC 2, through the real CLI against a real
 * census: the whole pipeline — parse, validate, simulate, order, apply — and
 * the `gh` calls it actually made, in the order it made them.
 */
describe("the CLI applies a rescue, in order", () => {
  const BODY = "## What to build\n\nA thing.\n\n## Acceptance criteria\n\n- [ ] It works somehow.\n";
  const BLOCK = "blocked: PR #900 red twice in CI; not reproducible locally";
  const LABELS = ["ready-for-agent", "spec", "needs-info", "ralph-wip", "ralph-blocked", "rafa-blocked"];
  const AT = "2026-01-01T00:00:00Z";
  const ENV = { RALPH_LOOP_NAME: "ralph" };

  const comment = (body: string, createdAt = AT): { body: string; createdAt: string } => ({ body, createdAt });
  const blockRecord = comment(BLOCK);

  /** Built through `formatTriageMarker`, as every other suite here builds one. */
  const unblockMark = (attempt: number, createdAt: string): { body: string; createdAt: string } =>
    comment(
      `${unblockLead("rafa")}\n\n${formatTriageMarker(
        { attempt, outcome: "specced", body: triageBodyHash(BODY) },
        { loop: "ralph", unit: 12, op: UNBLOCK_MARKER_OP, labels: ["rafa-blocked"] },
      )}`,
      createdAt,
    );

  const census = (comments: { body: string; createdAt: string }[], labels: string[]): unknown => ({
    data: {
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              number: 12,
              title: "rafa gave up on it",
              body: BODY,
              author: { login: "your-github-login" },
              labels: { nodes: labels.map((name) => ({ name })) },
              assignees: { nodes: [] },
              comments: { nodes: comments },
              blockedBy: { totalCount: 0, nodes: [] },
            },
          ],
        },
      },
    },
  });

  const PARKED = ["ready-for-agent", "rafa-blocked", "ralph-wip"];

  /** One world: the same comments in the census tail and in the full read. */
  const world = (comments = [blockRecord], labels = PARKED) => ({
    census: census(comments, labels),
    comments,
    labels: LABELS,
    env: ENV,
  });

  const rescuePlan = {
    unit: 12,
    loop: "ralph",
    attempt: 1,
    outcome: "specced",
    ops: [
      {
        op: "set-section",
        opId: "s1",
        issue: 12,
        heading: "Acceptance criteria",
        mode: "replace",
        body: "- [ ] The retry backs off and gives up after three attempts.\n",
      },
      {
        op: "comment",
        opId: "c1",
        issue: 12,
        body:
          `${unblockLead("rafa")}\n\n` +
          `It was parked as: ${BLOCK}\n\n` +
          `Re-specified Acceptance criteria, which read:\n\n> - [ ] It works somehow.\n`,
      },
      { op: "unblock", opId: "u1", issue: 12, label: "rafa-blocked" },
    ],
  };

  const withOps = (ops: unknown[]): unknown => ({ ...rescuePlan, ops });

  // #22: this command reads its census without `frontierTracker()`, so it
  // must learn the project's repository itself, or its simulation binds
  // another repository's `owner/repo#n` that the frontier ignores. The
  // frontier's warning fires only once the own repository is known.
  it("reads an owner/repo#n under Blocked by as the frontier does", () => {
    const body = `${BODY}\n## Blocked by\n\n- example-org/archive#99\n- your-org/your-repo#98\n`;
    const crossRepo = census([blockRecord], PARKED) as {
      data: { repository: { issues: { nodes: { body: string }[] } } };
    };
    crossRepo.data.repository.issues.nodes[0]!.body = body;
    const result = runCli(rescuePlan, ["--dry-run"], { ...world(), census: crossRepo });
    expect(result.stderr).toContain(
      "next-tasks: ignoring example-org/archive#99: it is not an issue of your-org/your-repo, so it is no edge here",
    );
    expect(result.stderr).not.toContain("your-org/your-repo#98");
  });

  it("writes the re-spec, then the comment, then the label removal — AC 1", () => {
    const result = runCli(rescuePlan, [], world());
    expect(result.stderr).toBe("");
    expect(result.status).toBe(EXIT.ok);

    const writes = result.gh.filter((call) => WRITE.test(call));
    // The count as well as the order: a fifth write would otherwise pass.
    expect(writes).toHaveLength(5);
    expect(writes[0]).toContain("issue edit 12 --body");
    expect(writes[1]).toContain(`issue comment 12 --body ${unblockLead("rafa")}`);
    expect(writes[2]).toContain("issue edit 12 --remove-label rafa-blocked");
    // Then the release: this loop's own claim comes off, and the decision
    // marker goes on last of all.
    expect(writes[3]).toContain("--remove-label ralph-wip");
    expect(writes[4]).toContain("issue comment 12");
  });

  it("stamps the op=unblock marker onto the comment itself — the rescue count", () => {
    // The plan does not carry it: the hash is a truncated sha256 of the issue
    // body, and a marker the plan wrote would be posted whether or not the
    // label removal after it succeeded.
    const posted = runCli(rescuePlan, [], world()).gh.find((call) => call.startsWith("issue comment"));
    expect(posted).toBeDefined();
    expect(posted).toContain(`op=${UNBLOCK_MARKER_OP}`);
    expect(posted).toContain("loop=ralph");
    // Against the RE-SPECIFIED body: the decision was made about that one.
    expect(posted).toContain(
      `body=${triageBodyHash(BODY.replace("- [ ] It works somehow.\n", "- [ ] The retry backs off and gives up after three attempts.\n"))}`,
    );
  });

  it("refuses a plan whose only write is the unblock, with zero writes — AC 2", () => {
    const result = runCli(withOps(rescuePlan.ops.slice(1)), [], world());
    expect(result.status).toBe(EXIT.refused);
    expect(result.stderr).toContain("changes neither the spec nor the route");
    expect(result.gh.filter((call) => WRITE.test(call))).toEqual([]);
  });

  it("refuses remove-label of the same block, with zero writes — AC 2", () => {
    const result = runCli(
      withOps(rescuePlan.ops.map((op) => (op.op === "unblock" ? { ...op, op: "remove-label" } : op))),
      [],
      world(),
    );
    expect(result.status).toBe(EXIT.refused);
    expect(result.stderr).toContain(`"rafa-blocked" is rafa's claim label`);
    expect(result.gh.filter((call) => WRITE.test(call))).toEqual([]);
  });

  it("refuses a rescue of a migration block, with zero writes — AC 2", () => {
    const result = runCli(
      rescuePlan,
      [],
      world([comment("needs-migration: draft PR #900 ready; apply drizzle/0062_x.sql first")]),
    );
    expect(result.status).toBe(EXIT.refused);
    expect(result.stderr).toContain("blocked on a migration");
    expect(result.gh.filter((call) => WRITE.test(call))).toEqual([]);
  });

  it("refuses a rescue of a flake block, with zero writes — AC 2", () => {
    const result = runCli(
      rescuePlan,
      [],
      world([comment("blocked: PR #900 red on a flaky test (src/a.test.ts), not the diff")]),
    );
    expect(result.status).toBe(EXIT.refused);
    expect(result.stderr).toContain("that is the ci-doctor's, not a re-spec");
    expect(result.gh.filter((call) => WRITE.test(call))).toEqual([]);
  });

  it("refuses a rescue inside the window, with zero writes — AC 2", () => {
    const result = runCli(rescuePlan, [], {
      ...world([unblockMark(1, new Date(Date.now() - 2 * 86_400_000).toISOString()), blockRecord]),
      env: { ...ENV, RALPH_TRIAGE_UNBLOCK_DAYS: "7" },
    });
    expect(result.status).toBe(EXIT.refused);
    expect(result.stderr).toContain("inside RALPH_TRIAGE_UNBLOCK_DAYS (7)");
    expect(result.gh.filter((call) => WRITE.test(call))).toEqual([]);
  });

  it("refuses a third rescue, with zero writes — AC 4", () => {
    const result = runCli(
      rescuePlan,
      [],
      world([unblockMark(1, "2026-01-01T00:00:00Z"), unblockMark(2, "2026-02-01T00:00:00Z"), blockRecord]),
    );
    expect(result.status).toBe(EXIT.refused);
    expect(result.stderr).toContain("unblocked 2 times already");
    expect(result.gh.filter((call) => WRITE.test(call))).toEqual([]);
  });

  it("counts a rescue that has scrolled off the census tail — AC 4", () => {
    // The census carries `comments(last: 20)`. The cap is counted off the FULL
    // read instead, so two old markers still bar a third rescue even when the
    // tail no longer shows them. This is the case a tail-only count fails OPEN
    // on, which is the one direction a cap must not fail.
    const old = [unblockMark(1, "2026-01-01T00:00:00Z"), unblockMark(2, "2026-02-01T00:00:00Z")];
    const result = runCli(rescuePlan, [], {
      census: census([blockRecord], PARKED),
      comments: [...old, blockRecord],
      labels: LABELS,
      env: ENV,
    });
    expect(result.status).toBe(EXIT.refused);
    expect(result.stderr).toContain("unblocked 2 times already");
    expect(result.gh.filter((call) => WRITE.test(call))).toEqual([]);
  });

  it("refuses when the full read finds an EMPTY thread, with zero writes", () => {
    // No `comments.json`, so the fake answers `{"comments":[]}` — a successful
    // read of an empty thread. The read FAILING is covered in
    // `triage/validate.test.ts`; the point here is that an empty thread refuses
    // too, because nothing on it says what the coder gave up on.
    const result = runCli(rescuePlan, [], { census: census([blockRecord], PARKED), labels: LABELS, env: ENV });
    expect(result.status).toBe(EXIT.refused);
    expect(result.stderr).toContain("no readable block record");
    expect(result.gh.filter((call) => WRITE.test(call))).toEqual([]);
  });
});
