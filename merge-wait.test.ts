// @vitest-environment node
/**
 * What `merge-wait.ts` promises the prompt: exit 0 means MERGED and nothing
 * else does. The subprocess is the seam — the script is run as the iteration
 * runs it, against a fake `gh` on PATH that answers `pr view` from a numbered
 * sequence of fixtures, so the argv, the polling and the exit code are all
 * under test rather than a mock of them.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  DEFAULT_GRACE_POLLS,
  EXIT,
  judge,
  parseArgs,
  parseSnapshot,
  resultPath,
  type Labels,
} from "./merge-wait";
import type { WaitResult } from "./pr-wait";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs merge-wait.ts under bun with fake gh");

const SCRIPT = join(import.meta.dirname, "merge-wait.ts");
const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();

const fakeBinDir = mkdtempSync(join(tmpdir(), "ralph-merge-wait-"));
writeFileSync(
  join(fakeBinDir, "gh"),
  [
    "#!/bin/sh",
    "# Fake gh for merge-wait.test.ts: answers `pr view` call N from",
    "# $FAKE_DIR/N.json and `api graphql` call N from $FAKE_DIR/qN.json, each",
    "# on its own counter, repeating the last fixture forever; a fixture",
    "# containing FAIL is a gh failure. Every call's argv is appended to",
    "# $FAKE_DIR/argv.",
    "printf '%s\\n' \"gh $*\" >> \"$FAKE_DIR/argv\"",
    'p=""; [ "$1" = "api" ] && p="q"',
    'i=$(cat "$FAKE_DIR/${p}count" 2>/dev/null || echo 0); echo $((i+1)) > "$FAKE_DIR/${p}count"',
    'f="$FAKE_DIR/$p$i.json"; while [ ! -f "$f" ] && [ "$i" -gt 0 ]; do i=$((i-1)); f="$FAKE_DIR/$p$i.json"; done',
    '[ -f "$f" ] || { echo "no fixture" >&2; exit 1; }',
    'if [ "$(cat "$f")" = "FAIL" ]; then echo "gh: boom" >&2; exit 1; fi',
    'cat "$f"',
    "",
  ].join("\n"),
);
chmodSync(join(fakeBinDir, "gh"), 0o755);

afterAll(() => rmSync(fakeBinDir, { recursive: true, force: true }));

const view = (state: string, labels: string[], mergedAt: string | null = null): string =>
  JSON.stringify({ state, mergedAt, labels: labels.map((name) => ({ name })) });

const OPEN = view("OPEN", []);
const QUEUED = view("OPEN", ["queued"]);
const DEQUEUED = view("OPEN", ["dequeued"]);
const MERGED = view("MERGED", [], "2026-09-14T20:00:00Z");
const CLOSED = view("CLOSED", []);

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  argv: string[];
  /** The fake project root the run wrote its result file under. */
  root: string;
}

/** Run the script against a sequence of `gh pr view` answers (and `gh api graphql` ones), fast. */
function run(sequence: string[], extra: string[] = [], over: Record<string, string> = {}, queue: string[] = []): Run {
  const dir = mkdtempSync(join(fakeBinDir, "case-"));
  sequence.forEach((body, i) => writeFileSync(join(dir, `${i}.json`), body));
  queue.forEach((body, i) => writeFileSync(join(dir, `q${i}.json`), body));
  const result = spawnSync(
    BUN,
    [SCRIPT, "948", "--repo", "example-org/acme-app", "--interval", "0.005", "--timeout", "10", ...extra],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        FAKE_DIR: dir,
        RALPH_PROJECT: dir,
        RALPH_RUN_ID: "rafa-run-20261005T203629-437810",
        RALPH_ITERATION: "7",
        RALPH_SESSION_ID: "cff94705-d3aa-42eb",
        ...over,
      },
    },
  );
  const argvFile = join(dir, "argv");
  const argv = existsSync(argvFile) ? readFileSync(argvFile, "utf8").trim().split("\n") : [];
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr, argv, root: dir };
}

describe("the exit code is the outcome", () => {
  it("exits 0 with `merged` once GitHub reports MERGED, and not before", () => {
    const result = run([QUEUED, QUEUED, MERGED]);
    expect(result.status).toBe(EXIT.merged);
    expect(result.stdout).toBe("merged 2026-09-14T20:00:00Z");
    expect(result.argv).toHaveLength(3);
  });

  it("asks gh for exactly the PR it was given, in the repo it was given", () => {
    const result = run([MERGED]);
    expect(result.argv[0]).toBe("gh pr view 948 --json state,mergedAt,labels --repo example-org/acme-app");
  });

  it("returns at once when the merge was immediate (no queue in the way)", () => {
    expect(run([MERGED]).status).toBe(EXIT.merged);
  });

  it("exits 2 when a queued PR falls out of the queue", () => {
    const result = run([QUEUED, DEQUEUED]);
    expect(result.status).toBe(EXIT.dequeued);
    expect(result.stdout).toMatch(/^dequeued: #948 left the queue/);
  });

  it("exits 2 when the PR never entered the queue, after the grace polls", () => {
    const result = run([OPEN], ["--grace", "2"]);
    expect(result.status).toBe(EXIT.dequeued);
    expect(result.stdout).toMatch(/never entered the queue within 2 polls/);
    expect(result.argv).toHaveLength(2);
  });

  it("gives Mergify a few polls to answer the command before calling it never-queued", () => {
    expect(run([OPEN, OPEN, QUEUED, MERGED]).status).toBe(EXIT.merged);
  });

  it("does not mistake a stale `dequeued` from the last round for this round's verdict", () => {
    expect(run([DEQUEUED, QUEUED, MERGED]).status).toBe(EXIT.merged);
  });

  it("exits 3 when the PR is closed without merging", () => {
    const result = run([QUEUED, CLOSED]);
    expect(result.status).toBe(EXIT.closed);
    expect(result.stdout).toMatch(/^closed/);
  });

  it("exits 4 at the deadline while still queued — it never hangs", () => {
    // A deadline of one second, not a few milliseconds: a single fake `gh` call
    // can take longer than 50 ms on a loaded host, and the script must have
    // polled more than once before the deadline for the argv check to hold.
    const result = run([QUEUED], ["--timeout", "1"]);
    expect(result.status).toBe(EXIT.timeout);
    expect(result.stdout).toMatch(/^timeout/);
    expect(result.argv.length).toBeGreaterThan(1);
  });

  it("exits 5 when gh keeps failing, after a bounded number of attempts", () => {
    const result = run(["FAIL"]);
    expect(result.status).toBe(EXIT.unreadable);
    expect(result.stdout).toMatch(/^unreadable after 5 consecutive failures/);
    expect(result.argv).toHaveLength(5);
  });

  it("rides out a transient gh failure", () => {
    expect(run(["FAIL", QUEUED, MERGED]).status).toBe(EXIT.merged);
  });

  it("treats output that is not a PR as a failed read", () => {
    const result = run(['{"state":"WEIRD","labels":[]}']);
    expect(result.status).toBe(EXIT.unreadable);
    expect(result.stderr).toMatch(/unparseable/);
  });

  it("exits 64 without a PR to wait for", () => {
    const result = spawnSync(BUN, [SCRIPT], { encoding: "utf8" });
    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/which pull request/);
  });
});

const inQueue = (value: boolean): string => JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: value } } } });
const IN = inQueue(true);
const OUT = inQueue(false);
const GRAPHQL =
  "gh api graphql -f query=query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { isInMergeQueue } } } -F owner=example-org -F name=acme-app -F number=948";

describe("the merge method decides what in the queue means", () => {
  const numbered = (state: string, mergedAt: string | null = null): string =>
    JSON.stringify({ state, mergedAt, labels: [], number: 948 });

  it("mergify, and no method at all, make exactly today's gh calls", () => {
    for (const result of [run([QUEUED, MERGED], ["--method", "mergify"]), run([QUEUED, MERGED], [], { RALPH_MERGE_METHOD: "" })]) {
      expect(result.status).toBe(EXIT.merged);
      expect(result.argv).toEqual([
        "gh pr view 948 --json state,mergedAt,labels --repo example-org/acme-app",
        "gh pr view 948 --json state,mergedAt,labels --repo example-org/acme-app",
      ]);
    }
  });

  it("github-queue: follows isInMergeQueue, not a label, to the merge", () => {
    const result = run([numbered("OPEN"), numbered("OPEN"), numbered("MERGED", "2026-11-24T10:00:00Z")], ["--method", "github-queue"], {}, [IN]);
    expect(result.status).toBe(EXIT.merged);
    expect(result.stdout).toBe("merged 2026-11-24T10:00:00Z");
    // The queue is read first, so the state read is the later of the two.
    expect(result.argv[0]).toBe(GRAPHQL);
    expect(result.argv[1]).toBe("gh pr view 948 --json state,mergedAt,labels --repo example-org/acme-app");
  });

  it("github-queue: a PR merged between the queue read and the state read is merged, not dequeued", () => {
    // The queue already let it go when asked; the later state read sees the merge.
    const result = run([numbered("OPEN"), numbered("MERGED", "2026-11-24T10:00:00Z")], ["--method", "github-queue"], {}, [IN, OUT]);
    expect(result.status).toBe(EXIT.merged);
  });

  it("github-queue: a PR taken out of the queue is dequeued", () => {
    const result = run([numbered("OPEN")], ["--method", "github-queue"], {}, [IN, OUT]);
    expect(result.status).toBe(EXIT.dequeued);
    expect(result.stdout).toBe("dequeued: #948 removed from GitHub's merge queue: its build failed or it was removed; read the PR's merge queue events");
  });

  it("github-queue: a PR that never entered is dequeued after the grace polls", () => {
    const result = run([numbered("OPEN")], ["--method", "github-queue", "--grace", "2"], {}, [OUT]);
    expect(result.status).toBe(EXIT.dequeued);
    expect(result.stdout).toMatch(/never entered GitHub's merge queue within 2 polls/);
    expect(result.stdout).not.toMatch(/Mergify/);
  });

  it("github-queue: a failing queue read counts as an unreadable poll", () => {
    const result = run([numbered("OPEN")], ["--method", "github-queue"], {}, ["FAIL"]);
    expect(result.status).toBe(EXIT.unreadable);
    expect(result.stdout).toMatch(/^unreadable after 5 consecutive failures: merge queue read/);
  });

  it("github-queue: names the current repo by placeholder when none is given", () => {
    const dir = mkdtempSync(join(fakeBinDir, "norepo-"));
    writeFileSync(join(dir, "0.json"), numbered("OPEN"));
    writeFileSync(join(dir, "1.json"), numbered("MERGED", "2026-11-24T10:00:00Z"));
    writeFileSync(join(dir, "q0.json"), IN);
    const result = spawnSync(BUN, [SCRIPT, "948", "--method", "github-queue", "--interval", "0.005"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`, FAKE_DIR: dir, RALPH_PROJECT: dir },
    });
    expect(result.status).toBe(EXIT.merged);
    expect(readFileSync(join(dir, "argv"), "utf8")).toContain("-F owner={owner} -F name={repo} -F number=948");
  });

  it("direct: merged on the first poll returns at once, with no queue read", () => {
    const result = run([MERGED], ["--method", "direct"]);
    expect(result.status).toBe(EXIT.merged);
    expect(result.argv).toEqual(["gh pr view 948 --json state,mergedAt,labels --repo example-org/acme-app"]);
  });

  it("direct: still open past the grace polls is a merge that did not land, not a queue", () => {
    // A stray `queued` label means nothing without a queue.
    const result = run([QUEUED], ["--method", "direct", "--grace", "2"]);
    expect(result.status).toBe(EXIT.dequeued);
    expect(result.stdout).toBe("dequeued: #948 `gh pr merge` did not land within 2 polls; read its output and the PR's merge state");
    expect(result.argv).toHaveLength(2);
  });

  it("direct: closed is closed", () => {
    expect(run([CLOSED], ["--method", "direct"]).status).toBe(EXIT.closed);
  });

  it("takes the method from RALPH_MERGE_METHOD when no flag names one", () => {
    const result = run([OPEN], ["--grace", "1"], { RALPH_MERGE_METHOD: "direct" });
    expect(result.status).toBe(EXIT.dequeued);
    expect(result.stdout).toMatch(/did not land/);
  });

  it("refuses a method it does not know", () => {
    const result = run([MERGED], ["--method", "bors"]);
    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/--method must be one of mergify, github-queue, direct/);
    expect(result.argv).toEqual([]);
  });
});

describe("the result file the CI-time metric reads (#163)", () => {
  const results = (root: string): WaitResult[] => {
    const dir = join(root, ".ralph", "logs");
    return (existsSync(dir) ? readdirSync(dir) : [])
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as WaitResult);
  };

  it("files a merge wait in the same shape and directory as the supervisor's CI waits", () => {
    const run1 = run([QUEUED, MERGED]);
    expect(run1.status).toBe(EXIT.merged);
    const [result] = results(run1.root);
    expect(result).toEqual({
      outcome: "merged",
      mode: "merge",
      pr: "948",
      head: null,
      polls: 2,
      elapsedSeconds: expect.any(Number),
      checks: [],
      detail: "merged 2026-09-14T20:00:00Z",
    });
  });

  it("names the file for the run and the iteration, so the dashboard groups it as one", () => {
    const first = run([QUEUED, MERGED]);
    expect(readdirSync(join(first.root, ".ralph", "logs"))).toEqual([
      "pr-wait-session-rafarun20261005T203629437810-7-1.json",
    ]);
  });

  it("numbers a second round in the same iteration rather than overwriting the first", () => {
    const root = mkdtempSync(join(fakeBinDir, "rounds-"));
    const env = { RALPH_PROJECT: root, RALPH_RUN_ID: "run-a", RALPH_ITERATION: "3" };
    const logs = join(root, ".ralph", "logs");
    expect(resultPath(env)).toBe(join(logs, "pr-wait-session-runa-3-1.json"));
    mkdirSync(logs, { recursive: true });
    writeFileSync(resultPath(env), "{}");
    expect(resultPath(env)).toBe(join(logs, "pr-wait-session-runa-3-2.json"));
  });

  it("keys on the iteration and not the session, which a phase retry replaces", () => {
    // `ralph.sh` mints a fresh session inside one iteration on a phase retry.
    // Keying on it would split that iteration's queue waits in two.
    const root = mkdtempSync(join(fakeBinDir, "retry-"));
    const base = { RALPH_PROJECT: root, RALPH_RUN_ID: "run-a", RALPH_ITERATION: "3" };
    mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
    const first = resultPath({ ...base, RALPH_SESSION_ID: "session-one" });
    writeFileSync(first, "{}");
    const second = resultPath({ ...base, RALPH_SESSION_ID: "session-two" });
    expect(second).toBe(first.replace("-1.json", "-2.json"));
  });

  it("falls back to the session, then to a key of its own, for a script run by hand", () => {
    const root = mkdtempSync(join(fakeBinDir, "nosession-"));
    expect(resultPath({ RALPH_PROJECT: root, RALPH_SESSION_ID: "cff94705-d3aa-42eb" })).toBe(
      join(root, ".ralph", "logs", "pr-wait-session-cff94705d3aa-1.json"),
    );
    expect(resultPath({ RALPH_PROJECT: root })).toMatch(/pr-wait-session-pid\d+-\d+-1\.json$/);
  });

  it("records the unhappy endings too, with the detail it printed", () => {
    for (const [sequence, outcome, code] of [
      [[CLOSED], "closed", EXIT.closed],
      [[QUEUED, DEQUEUED], "dequeued", EXIT.dequeued],
      [["FAIL", "FAIL", "FAIL", "FAIL", "FAIL"], "unreadable", EXIT.unreadable],
    ] as const) {
      const result = run([...sequence]);
      expect(result.status).toBe(code);
      const [filed] = results(result.root);
      expect(filed?.outcome).toBe(outcome);
      expect(filed?.mode).toBe("merge");
      expect(filed?.detail).toBe(result.stdout);
    }
  });

  it("records a timeout, and the elapsed seconds the metric sums", () => {
    const timed = run([QUEUED], ["--timeout", "0"]);
    expect(timed.status).toBe(EXIT.timeout);
    const [filed] = results(timed.root);
    expect(filed?.outcome).toBe("timeout");
    expect(filed?.elapsedSeconds).toBeTypeOf("number");
  });

  it("still merges when the result file cannot be written", () => {
    // `.ralph` is a FILE in this root, so `mkdir -p .ralph/logs` cannot
    // succeed. The merge is the answer; the metric is not worth an iteration.
    const root = mkdtempSync(join(fakeBinDir, "unwritable-"));
    writeFileSync(join(root, ".ralph"), "not a directory");
    const blocked = run([MERGED], [], { RALPH_PROJECT: root });
    expect(blocked.status).toBe(EXIT.merged);
    expect(blocked.stdout).toBe("merged 2026-09-14T20:00:00Z");
    expect(blocked.stderr).toContain("could not record the wait");
  });
});

describe("judge: one read, given what came before", () => {
  const labels: Labels = { queued: "queued", dequeued: "dequeued" };
  const snap = (state: "OPEN" | "CLOSED" | "MERGED", names: string[]) => ({ state, mergedAt: null, labels: names });

  it.each([
    ["MERGED wins over everything", snap("MERGED", ["queued"]), { polls: 1, sawQueued: true }, "merged"],
    ["CLOSED is final", snap("CLOSED", ["queued"]), { polls: 1, sawQueued: true }, "closed"],
    ["queued means wait", snap("OPEN", ["queued", "ralph-wip"]), { polls: 9, sawQueued: true }, "wait"],
    ["once queued, not queued means dequeued — no grace", snap("OPEN", []), { polls: 2, sawQueued: true }, "dequeued"],
    ["the dequeued label after being queued", snap("OPEN", ["dequeued"]), { polls: 5, sawQueued: true }, "dequeued"],
    ["bare inside the grace window waits", snap("OPEN", []), { polls: DEFAULT_GRACE_POLLS - 1, sawQueued: false }, "wait"],
    ["bare at the end of the grace window never got in", snap("OPEN", []), { polls: DEFAULT_GRACE_POLLS, sawQueued: false }, "dequeued"],
    ["a stale dequeued inside the grace window waits", snap("OPEN", ["dequeued"]), { polls: 1, sawQueued: false }, "wait"],
    ["isInMergeQueue true waits without a label", { ...snap("OPEN", []), inQueue: true }, { polls: 9, sawQueued: true }, "wait"],
    ["isInMergeQueue false overrides a queued label", { ...snap("OPEN", ["queued"]), inQueue: false }, { polls: 2, sawQueued: true }, "dequeued"],
  ] as const)("%s", (_name, snapshot, progress, expected) => {
    expect(judge(snapshot, progress, labels, DEFAULT_GRACE_POLLS)).toBe(expected);
  });
});

describe("parsing", () => {
  it("reads labels by name and tolerates a missing mergedAt", () => {
    expect(parseSnapshot('{"state":"OPEN","labels":[{"name":"queued","color":"0e8a16"}]}')).toEqual({
      state: "OPEN",
      mergedAt: null,
      labels: ["queued"],
    });
  });

  it.each(["", "[]", "null", '{"state":"OPEN"}', '{"state":"MERGED","labels":[{}]}', '{"state":"OPEN","labels":[],"mergedAt":5}'])(
    "rejects %j",
    (raw) => {
      expect(parseSnapshot(raw)).toBeNull();
    },
  );

  it("accepts the flags and refuses the rest", () => {
    const options = parseArgs(["42", "--repo", "a/b", "--timeout", "1", "--interval", "0.5", "--grace", "1", "--queued-label", "q", "--dequeued-label", "d"]);
    expect(options).toMatchObject({ pr: "42", repo: "a/b", timeoutSeconds: 1, intervalSeconds: 0.5, gracePolls: 1, labels: { queued: "q", dequeued: "d" } });
    expect(parseArgs([])).toMatch(/which pull request/);
    expect(parseArgs(["1", "2"])).toMatch(/one pull request at a time/);
    expect(parseArgs(["1", "--timeout", "soon"])).toMatch(/--timeout needs a non-negative number/);
    expect(parseArgs(["1", "--bogus"])).toMatch(/unknown flag/);
  });
});
