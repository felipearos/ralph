// @vitest-environment node
/**
 * The snapshot guard's own unit suite. It must notice the artifacts suites were
 * leaking into `<repo>/.ralph/logs` while ignoring what a live supervisor
 * writes there on its own account.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type Change,
  describeChanges,
  diffTrees,
  guardedRoots,
  liveLoopPaths,
  liveOperatorCommands,
  offences,
  snapshotRoots,
  snapshotTree,
} from "./test-ralph-logs";
import { scratchDir } from "./test-scratch";

const scratch = (): string => scratchDir("ralph-logs-guard-");

/** `kind` by path, which is all the assertions below care about. */
const kinds = (changes: readonly Change[]): Record<string, string> =>
  Object.fromEntries(changes.map((change) => [change.path, change.kind]));

describe("snapshotTree", () => {
  it("is empty for a directory that does not exist", () => {
    expect(snapshotTree(join(scratch(), "nope"))).toEqual(new Map());
  });

  it("keys every file and directory by its relative path", () => {
    const root = scratch();
    mkdirSync(join(root, "logs", "locks"), { recursive: true });
    writeFileSync(join(root, "logs", "locks", "a.lock"), "");
    writeFileSync(join(root, "top.json"), "{}");

    expect([...snapshotTree(root).keys()].sort()).toEqual([
      "logs",
      "logs/locks",
      "logs/locks/a.lock",
      "top.json",
    ]);
  });

  it("throws on a root it cannot read, rather than reporting it as empty", () => {
    // Snapshotting an unreadable root as empty twice over would report no
    // changes and pass the run.
    const root = scratch();
    mkdirSync(join(root, "sealed"));
    chmodSync(join(root, "sealed"), 0o000);
    try {
      expect(() => snapshotTree(join(root, "sealed"))).toThrow();
    } finally {
      chmodSync(join(root, "sealed"), 0o700);
    }
  });

  it("notices a directory left behind, even an empty one", () => {
    const root = scratch();
    const before = snapshotTree(root);
    mkdirSync(join(root, "logs", "opencode-db"), { recursive: true });

    expect(diffTrees(before, snapshotTree(root)).map((change) => change.path)).toEqual([
      "logs",
      "logs/opencode-db",
    ]);
  });

  it("records a size, so a rewrite is visible", () => {
    const root = scratch();
    writeFileSync(join(root, "a"), "xyz");
    expect(snapshotTree(root).get("a")?.size).toBe(3);
  });
});

describe("diffTrees", () => {
  it("reports nothing for an untouched tree", () => {
    const root = scratch();
    writeFileSync(join(root, "a"), "a");
    const before = snapshotTree(root);

    expect(diffTrees(before, snapshotTree(root))).toEqual([]);
  });

  it("reports added, changed and removed paths, sorted by path", () => {
    const root = scratch();
    writeFileSync(join(root, "b-changed"), "one");
    writeFileSync(join(root, "c-removed"), "gone soon");
    const before = snapshotTree(root);

    writeFileSync(join(root, "a-added"), "new");
    writeFileSync(join(root, "b-changed"), "a different length");
    rmSync(join(root, "c-removed"));
    const changes = diffTrees(before, snapshotTree(root));

    expect(changes.map((change) => change.path)).toEqual(["a-added", "b-changed", "c-removed"]);
    expect(kinds(changes)).toEqual({ "a-added": "added", "b-changed": "changed", "c-removed": "removed" });
  });

  it("drops the paths `ignore` claims, on both sides of the diff", () => {
    const root = scratch();
    writeFileSync(join(root, "kept"), "x");
    writeFileSync(join(root, "mine"), "x");
    const before = snapshotTree(root);

    rmSync(join(root, "mine"));
    writeFileSync(join(root, "theirs"), "x");
    const changes = diffTrees(before, snapshotTree(root), (path) => path === "mine" || path === "theirs");

    expect(changes).toEqual([]);
  });
});

describe("liveLoopPaths", () => {
  const env = { RALPH_RUN_ID: "ralph-run-20261005T234337", RALPH_SESSION_ID: "8e2d8ccd-2d57" };
  const pollution = [
    "logs/inspect-mapper-20261005T235806.log",
    "logs/locks/inspect-mapper-abc.lock",
    "logs/notifications.jsonl",
    "logs/push-notifications.json",
    "logs/runner-failures.jsonl",
    "logs/codex-thread-00000000-0000-4000-8000-000000000000.json",
    "logs/host-lease-20261005-1234-1-1.json",
    "logs/opencode-db/stage.db",
  ];

  it("ignores the running loop's own run- and session-named files", () => {
    const ignored = liveLoopPaths(env);
    expect(ignored("logs/supervisor-ralph-run-20261005T234337.log")).toBe(true);
    expect(ignored("logs/codex-orchestrator-8e2d8ccd-2d57.jsonl")).toBe(true);
  });

  it("ignores the fixed supervisor names while a loop is live", () => {
    const ignored = liveLoopPaths(env);
    expect(ignored("logs/supervisor.lock")).toBe(true);
    expect(ignored("logs/supervisor.pid")).toBe(true);
    expect(ignored("logs/loop.stdout")).toBe(true);
    expect(ignored("logs/state.json")).toBe(true);
    expect(ignored("logs/usage-state-ralph.json")).toBe(true);
    // Named by timestamp and pid, so no run id can match them.
    expect(ignored("logs/iter-20261005T234342-1026000-1.events.jsonl")).toBe(true);
    expect(ignored("logs/signals-orchestrator-20261005T234342-1026000-1.jsonl")).toBe(true);
    expect(ignored("logs/phases")).toBe(true);
    expect(ignored("logs/phases/199.jsonl")).toBe(true);
  });

  it("ignores nothing whatsoever with no loop identity", () => {
    // A fresh worktree and CI are where "a full run leaves `.ralph/` unchanged"
    // is judged, and there every one of these names is a suite's doing.
    const ignored = liveLoopPaths({});
    for (const path of [...pollution, "logs/supervisor.lock", "logs/state.json",
      "logs/iter-20261005T234342-1.events.jsonl", "logs/phases/199.jsonl"]) {
      expect(ignored(path), path).toBe(false);
    }
  });

  it("never excuses another run's supervisor log, only the live one's", () => {
    // A supervisor a fixture started has a run id of its own, which is the
    // 2,488-line incident this guard has to stay able to see.
    const ignored = liveLoopPaths(env);
    expect(ignored("logs/supervisor-ralph-run-20261005T234337.log")).toBe(true);
    expect(ignored("logs/supervisor-ralph-run-fixture.log")).toBe(false);
  });

  it("anchors the fixed names, so a leak into a subdirectory is not excused", () => {
    const ignored = liveLoopPaths(env);
    expect(ignored("logs/opencode-db/state.json")).toBe(false);
    expect(ignored("logs/inspect-phases/leak.json")).toBe(false);
  });

  it("never ignores the artifacts this guard exists to catch", () => {
    for (const path of pollution) {
      expect(liveLoopPaths(env)(path), path).toBe(false);
      expect(liveLoopPaths({})(path), path).toBe(false);
    }
  });

  it("ignores nothing extra when the identity is present but empty", () => {
    // `"".includes("")` is true, so an unset-but-exported id would otherwise
    // match every path and disable the guard outright.
    const ignored = liveLoopPaths({ RALPH_RUN_ID: "", RALPH_SESSION_ID: "   " });
    for (const path of pollution) expect(ignored(path), path).toBe(false);
    expect(ignored("logs/supervisor-ralph-run-1.log")).toBe(false);
  });
});

describe("liveOperatorCommands", () => {
  const live = { RALPH_RUN_ID: "ralph-run-live", RALPH_LOOP_NAME: "rafa" };
  const id = "aa2363c0-0000-4000-8000-000000000000";
  const path = `control/inbox/${id}.json`;

  /** A scratch `.ralph` whose inbox holds `content` as the one command. */
  function inbox(content: string): string {
    const root = scratch();
    mkdirSync(join(root, "control", "inbox"), { recursive: true });
    writeFileSync(join(root, path), content);
    return root;
  }
  const command = (fields: Record<string, unknown>): string =>
    JSON.stringify({ version: 1, id, command: "stop", ...fields });

  it("excuses the dashboard's command to the live run", () => {
    // PR #401: a real `stop` for the gated run, written mid-suite (#481).
    const root = inbox(command({ loop: "rafa", run: "ralph-run-live" }));
    expect(liveOperatorCommands(root, live)(path)).toBe(true);
  });

  it("excuses a command with no run when it names the live loop", () => {
    expect(liveOperatorCommands(inbox(command({ loop: "rafa" })), live)(path)).toBe(true);
    expect(liveOperatorCommands(inbox(command({ loop: "rafa", run: "" })), live)(path)).toBe(true);
  });

  it("treats a null run as no run, as the dashboard sends it", () => {
    expect(liveOperatorCommands(inbox(command({ loop: "rafa", run: null })), live)(path)).toBe(true);
    expect(liveOperatorCommands(inbox(command({ loop: "rulo", run: null })), live)(path)).toBe(false);
  });

  it("guesses no loop name when RALPH_LOOP_NAME is unset", () => {
    // ralph.sh always exports one; a default would excuse a leaked fixture
    // command addressed to `ralph`.
    const root = inbox(command({ loop: "ralph" }));
    expect(liveOperatorCommands(root, { RALPH_RUN_ID: "ralph-run-live" })(path)).toBe(false);
    const toRun = inbox(command({ loop: "ralph", run: "ralph-run-live" }));
    expect(liveOperatorCommands(toRun, { RALPH_RUN_ID: "ralph-run-live" })(path)).toBe(true);
  });

  it("never excuses an addressed object that is not a well-formed command", () => {
    for (const fields of [{ version: 2 }, { id: 7 }, { command: undefined }]) {
      const root = inbox(command({ loop: "rafa", run: "ralph-run-live", ...fields }));
      expect(liveOperatorCommands(root, live)(path), JSON.stringify(fields)).toBe(false);
    }
  });

  it("never excuses a command naming another run, even for the live loop", () => {
    const root = inbox(command({ loop: "rafa", run: "ralph-run-fixture" }));
    expect(liveOperatorCommands(root, live)(path)).toBe(false);
  });

  it("never excuses a command for another loop", () => {
    expect(liveOperatorCommands(inbox(command({ loop: "rulo" })), live)(path)).toBe(false);
    expect(liveOperatorCommands(inbox(command({})), live)(path)).toBe(false);
  });

  it("never excuses a file that is not a JSON object", () => {
    for (const content of ["{not json", "[]", "null", '"rafa"']) {
      expect(liveOperatorCommands(inbox(content), live)(path), content).toBe(false);
    }
  });

  it("never excuses a command it cannot read", () => {
    expect(liveOperatorCommands(scratch(), live)(path)).toBe(false);
  });

  it("excuses nothing with no loop identity", () => {
    // CI and a fresh worktree: a command in the inbox there is a test's.
    const root = inbox(command({ loop: "rafa", run: "ralph-run-live" }));
    for (const env of [{}, { RALPH_LOOP_NAME: "rafa" }, { RALPH_RUN_ID: "  ", RALPH_LOOP_NAME: "rafa" }]) {
      const ignored = liveOperatorCommands(root, env);
      for (const each of [path, "control", "control/inbox", "control/.gitignore", `control/inbox/.${id}.json.123.tmp`]) {
        expect(ignored(each), each).toBe(false);
      }
    }
  });

  it("excuses the structure a writer creates, and its temp files, only with an identity", () => {
    const ignored = liveOperatorCommands(scratch(), live);
    for (const each of ["control", "control/inbox", "control/.gitignore", `control/inbox/.${id}.json.123.tmp`]) {
      expect(ignored(each), each).toBe(true);
    }
  });

  it("excuses nothing else under control, nor anything under logs", () => {
    const root = inbox(command({ loop: "rafa", run: "ralph-run-live" }));
    const ignored = liveOperatorCommands(root, live);
    for (const each of [
      "control/processed",
      `control/processed/${id}.json`,
      `control/processed/${id}.outcome.json`,
      "control/inbox/nested",
      `control/inbox/nested/${id}.json`,
      "control/other.json",
      "logs/state.json",
      "logs/notifications.jsonl",
      `logs/${id}.json`,
    ]) {
      expect(ignored(each), each).toBe(false);
    }
  });
});

describe("the guarded roots", () => {
  it("watches the checkout's own tree and the tracked loggd fixture", () => {
    const roots = guardedRoots("/w", () => () => true);

    expect(roots.map(({ root }) => root)).toEqual(["/w/.ralph", "/w/fixtures/loggd/.ralph"]);
  });

  it("excuses the live loop in the checkout but nothing at all in the fixture", () => {
    // No supervisor has ever run in `fixtures/loggd`, so a write there is a
    // suite's -- and it is tracked, so it is a diff.
    const roots = guardedRoots("/w", () => (path) => path === "logs/state.json");

    expect(roots.map(({ ignore }) => ignore("logs/state.json"))).toEqual([true, false]);
  });

  it("reports each root's changes separately, under its own predicate", () => {
    const repo = scratch();
    mkdirSync(join(repo, ".ralph", "logs"), { recursive: true });
    mkdirSync(join(repo, "fixtures", "loggd", ".ralph", "logs"), { recursive: true });
    const roots = guardedRoots(repo, () => (path) => path === "logs/excused");
    const before = snapshotRoots(roots);

    writeFileSync(join(repo, ".ralph", "logs", "excused"), "x");
    writeFileSync(join(repo, ".ralph", "logs", "caught"), "x");
    writeFileSync(join(repo, "fixtures", "loggd", ".ralph", "logs", "excused"), "x");
    const found = offences(before, roots);

    expect(found.get(join(repo, ".ralph"))?.map((change) => change.path)).toEqual(["logs/caught"]);
    expect(found.get(join(repo, "fixtures", "loggd", ".ralph"))?.map((change) => change.path)).toEqual([
      "logs/excused",
    ]);
  });

  it("omits a root nothing happened in", () => {
    const repo = scratch();
    mkdirSync(join(repo, ".ralph", "logs"), { recursive: true });
    const roots = guardedRoots(repo, () => () => false);

    expect(offences(snapshotRoots(roots), roots).size).toBe(0);
  });
});

describe("describeChanges", () => {
  it("names the root, the count and the offending paths, and says what to do", () => {
    const message = describeChanges("/w/.ralph", [{ path: "logs/notifications.jsonl", kind: "added" }]);

    expect(message).toContain("/w/.ralph");
    expect(message).toContain("1 path(s)");
    expect(message).toContain("added   logs/notifications.jsonl");
    expect(message).toContain("RALPH_PROJECT");
  });

  it("counts the paths it does not name past the first twenty", () => {
    const changes: Change[] = Array.from({ length: 23 }, (_, i) => ({ path: `logs/f${i}`, kind: "added" }));
    const message = describeChanges("/w/.ralph", changes);

    expect(message).toContain("23 path(s)");
    expect(message).toContain("… and 3 more");
    expect(message).not.toContain("logs/f22");
  });
});
