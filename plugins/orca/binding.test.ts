// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ORCA_BINDING_RELATIVE_PATH,
  parseOrcaConsumerBinding,
  observerBindingKey,
  reconcileOrcaConsumerBinding,
  resolveOrcaConsumer,
  shouldAttemptObserverBinding,
} from "./binding";
import type { AdapterState, Called } from "./lifecycle";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), "loggd-orca-binding-"));
  roots.push(value);
  mkdirSync(join(value, ".ralph", "logs"), { recursive: true });
  return value;
};

const adapter = (worktree: string, over: Partial<AdapterState> = {}): AdapterState => ({
  version: 1,
  ralphRun: "ralph-1",
  loop: "ralph",
  worktree,
  terminal: "term_started",
  orcaRun: "run_1",
  task: null,
  attempt: null,
  degraded: null,
  displacedBinding: null,
  lastRejected: null,
  lastEvent: null,
  ...over,
});

const ok = (result: Record<string, unknown> = {}): Called => ({
  ok: true,
  result,
  why: "",
  kind: null,
  code: null,
});

describe("the replaceable Orca Run consumer", () => {
  it("binds an unbound observer and resolves it instead of the stale startup terminal", () => {
    const worktree = root();
    const calls: string[] = [];
    const result = reconcileOrcaConsumerBinding(
      worktree,
      adapter(worktree),
      "ralph-1",
      "term_observer",
      (verb, args) => {
        calls.push(`${verb} ${args.join(" ")}`);
        return verb === "orchestration run-current"
          ? ok({})
          : ok({ run: { id: "run_1" } });
      },
    );

    expect(result.status).toBe("bound");
    expect(calls).toEqual([
      "orchestration run-current --from term_observer",
      "orchestration run-use --id run_1 --from term_observer",
    ]);
    expect(resolveOrcaConsumer(
      worktree,
      adapter(worktree),
      { ralphRun: "ralph-1", worktree },
      "term_started",
    )).toBe(
      "term_observer",
    );
  });

  it("is idempotent when the observer already consumes this Run", () => {
    const worktree = root();
    const calls: string[] = [];
    const result = reconcileOrcaConsumerBinding(
      worktree,
      adapter(worktree),
      "ralph-1",
      "term_observer",
      (verb, args) => {
        calls.push(`${verb} ${args.join(" ")}`);
        return ok({ run: { id: "run_1" } });
      },
    );
    expect(result.status).toBe("already-bound");
    expect(calls).toEqual(["orchestration run-current --from term_observer"]);
  });

  it("refuses a foreign Run and never overwrites the last known-good binding", () => {
    const worktree = root();
    const path = join(worktree, ORCA_BINDING_RELATIVE_PATH);
    writeFileSync(path, JSON.stringify({
      version: 1,
      ralphRun: "ralph-1",
      orcaRun: "run_1",
      worktree,
      consumer: "term_safe",
      boundAt: "2026-09-13T00:00:00.000Z",
    }));
    const before = readFileSync(path, "utf8");
    const result = reconcileOrcaConsumerBinding(
      worktree,
      adapter(worktree),
      "ralph-1",
      "term_foreign",
      () => ok({ run: { id: "run_somebody_else" } }),
    );
    expect(result).toMatchObject({ status: "refused" });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("ignores a prior Ralph run and rebinds when the adapter rotates to a new Run", () => {
    const worktree = root();
    const first = adapter(worktree);
    reconcileOrcaConsumerBinding(worktree, first, "ralph-1", "term_observer", (verb) =>
      verb === "orchestration run-current" ? ok({}) : ok(),
    );
    expect(resolveOrcaConsumer(
      worktree, first, { ralphRun: "ralph-1", worktree }, "term_started",
    )).toBe("term_observer");

    const second = adapter(worktree, { ralphRun: "ralph-2", orcaRun: "run_2" });
    expect(resolveOrcaConsumer(
      worktree, second, { ralphRun: "ralph-2", worktree }, "term_rotated",
    )).toBe("term_rotated");
    expect(
      reconcileOrcaConsumerBinding(worktree, second, "ralph-1", "term_observer", () => ok())
        .status,
    ).toBe("skipped");
    reconcileOrcaConsumerBinding(worktree, second, "ralph-2", "term_observer", (verb) =>
      verb === "orchestration run-current" ? ok({}) : ok(),
    );
    expect(resolveOrcaConsumer(
      worktree, second, { ralphRun: "ralph-2", worktree }, "term_rotated",
    )).toBe("term_observer");
  });

  it("invalidates a recorded consumer that Orca confirms was reassigned", () => {
    const worktree = root();
    const current = adapter(worktree);
    reconcileOrcaConsumerBinding(worktree, current, "ralph-1", "term_observer", (verb) =>
      verb === "orchestration run-current" ? ok({}) : ok(),
    );
    const refused = reconcileOrcaConsumerBinding(
      worktree,
      current,
      "ralph-1",
      "term_observer",
      () => ok({ run: { id: "run_foreign" } }),
    );
    expect(refused.status).toBe("refused");
    expect(resolveOrcaConsumer(
      worktree, current, { ralphRun: "ralph-1", worktree }, "term_started",
    )).toBe("term_started");
    expect(parseOrcaConsumerBinding(readFileSync(
      join(worktree, ORCA_BINDING_RELATIVE_PATH), "utf8",
    ))).toBeNull();
  });

  it("refuses the confirmed-foreign consumer when it is also the startup fallback", () => {
    const worktree = root();
    const current = adapter(worktree, { terminal: "term_started" });
    reconcileOrcaConsumerBinding(worktree, current, "ralph-1", "term_started", (verb) =>
      verb === "orchestration run-current" ? ok({}) : ok(),
    );
    reconcileOrcaConsumerBinding(
      worktree,
      current,
      "ralph-1",
      "term_started",
      () => ok({ run: { id: "run_foreign" } }),
    );
    expect(resolveOrcaConsumer(
      worktree, current, { ralphRun: "ralph-1", worktree }, "term_started",
    )).toBeNull();
  });

  it("never uses a binding through a stale adapter identity", () => {
    const worktree = root();
    reconcileOrcaConsumerBinding(worktree, adapter(worktree), "ralph-1", "term_observer", (verb) =>
      verb === "orchestration run-current" ? ok({}) : ok(),
    );
    expect(resolveOrcaConsumer(
      worktree,
      adapter(worktree),
      { ralphRun: "ralph-2", worktree },
      "term_current",
    )).toBe("term_current");
  });

  it("throttles stable frames but makes Run rotation immediately eligible", () => {
    const worktree = root();
    writeFileSync(
      join(worktree, ".ralph/logs/orca-lifecycle.json"),
      JSON.stringify(adapter(worktree)),
    );
    const first = observerBindingKey(worktree, "ralph-1", "term_observer");
    expect(first).not.toBeNull();
    expect(shouldAttemptObserverBinding(first, null, 0, 1_000)).toBe(true);
    expect(shouldAttemptObserverBinding(first, first, 1_000, 2_000)).toBe(false);
    expect(shouldAttemptObserverBinding(first, first, 1_000, 61_000)).toBe(true);

    writeFileSync(
      join(worktree, ".ralph/logs/orca-lifecycle.json"),
      JSON.stringify(adapter(worktree, { ralphRun: "ralph-2", orcaRun: "run_2" })),
    );
    const rotated = observerBindingKey(worktree, "ralph-2", "term_observer");
    expect(rotated).not.toBe(first);
    expect(shouldAttemptObserverBinding(rotated, first, 1_000, 2_000)).toBe(true);
  });

  it("treats malformed records as absent", () => {
    expect(parseOrcaConsumerBinding("not json")).toBeNull();
    expect(parseOrcaConsumerBinding(JSON.stringify({ version: 1 }))).toBeNull();
  });
});
