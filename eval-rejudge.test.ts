import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "vitest";

import type { BacktestConfig } from "./backtest";
import type { BacktestReport } from "./backtest-report";
import { writeAtomic } from "./backtest-run";
import type { TicketScore } from "./backtest-score";
import type { StoredProposal } from "./eval-proposals";
import { rejudgeProposal, type Rescore } from "./eval-rejudge";
import { experimentsRoot } from "./eval-runs";
import { scratchDir } from "./test-scratch";

const RUN = "run-1";

/** Every file under `dir` and its bytes. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(dir, path)] = readFileSync(path, "base64");
    }
  };
  walk(dir);
  return files;
}

function sourceRun(project: string): string {
  const dir = join(experimentsRoot(project), RUN);
  mkdirSync(join(dir, "c1", "b"), { recursive: true });
  mkdirSync(join(dir, "proposals"), { recursive: true });
  const config = { project, sources: {} } as unknown as BacktestConfig;
  writeFileSync(join(dir, "state.json"), JSON.stringify({ id: RUN, config, sample: { tickets: [{ oaKey: "c1" }, { oaKey: "c2" }], arms: [] }, rows: {} }));
  writeFileSync(join(dir, "report.json"), JSON.stringify({
    rows: [{ ticket: "c1" }, { ticket: "c2" }], scores: [{ ticket: "c1" }, { ticket: "c2" }],
  }));
  writeFileSync(join(dir, "analyst.log"), "SOURCE LOG");
  writeFileSync(join(dir, "c1", "b", "arm.bundle"), "BUNDLE");
  writeFileSync(join(dir, "c1", "scores.json"), "{}");
  writeFileSync(join(dir, "eval.pid"), "1\n");
  return dir;
}

describe("rejudgeProposal", () => {
  test("rescores scratch copies cut to the calibrated cases, and leaves the source run byte-identical", async () => {
    const project = scratchDir("ralph-rejudge-");
    const source = sourceRun(project);
    const before = snapshot(source);
    const scratchParent = scratchDir("ralph-rejudge-scratch-");
    const seen: { runDir: string; tickets: string[]; rows: string[]; instructions: unknown; linked: boolean; pid: boolean }[] = [];
    const rescore: Rescore = async (config, options) => {
      const state = JSON.parse(readFileSync(join(options.runDir, "state.json"), "utf8")) as { sample: { tickets: { oaKey: string }[] } };
      const report = JSON.parse(readFileSync(join(options.runDir, "report.json"), "utf8")) as BacktestReport;
      seen.push({
        runDir: options.runDir, tickets: state.sample.tickets.map((ticket) => ticket.oaKey), rows: report.rows.map((row) => row.ticket),
        instructions: options.scoreDeps?.instructions, linked: statSync(join(options.runDir, "c1", "b", "arm.bundle")).nlink > 1,
        pid: existsSync(join(options.runDir, "eval.pid")),
      });
      expect(config.project).toBe(project);
      // What a rescore writes in place, and what it writes by rename.
      writeFileSync(join(options.runDir, "analyst.log"), "");
      appendFileSync(join(options.runDir, "analyst.log"), "SCRATCH LOG");
      writeAtomic(join(options.runDir, "c1", "scores.json"), "{\"rescored\":true}");
      const scores = [{ ticket: "c1", side: options.scoreDeps?.instructions?.judge }, { ticket: "c2" }] as unknown as TicketScore[];
      const rescored = { ...report, scores };
      writeAtomic(join(options.runDir, "report.json"), JSON.stringify(rescored));
      return { report: rescored, runDir: options.runDir };
    };
    const result = await rejudgeProposal({
      project, proposal: { id: "prop-1" } as StoredProposal, runId: RUN, cases: ["c1"], kind: "judge-prompt",
      instructions: { current: "CURRENT", proposed: "PROPOSED" },
    }, { rescore, scoreDeps: {} as never, signal: new AbortController().signal, log: () => {}, scratchParent });

    expect(seen.map((entry) => entry.instructions)).toEqual([{ judge: "CURRENT" }, { judge: "PROPOSED" }]);
    for (const entry of seen) {
      expect(entry.tickets).toEqual(["c1"]);
      expect(entry.rows).toEqual(["c1"]);
      expect(entry.linked).toBe(true);
      expect(entry.pid).toBe(false);
      expect(entry.runDir.startsWith(scratchParent)).toBe(true);
    }
    expect(result.current).toEqual([{ ticket: "c1", side: "CURRENT" }]);
    expect(result.proposed).toEqual([{ ticket: "c1", side: "PROPOSED" }]);
    expect(snapshot(source)).toEqual(before);
    expect(readdirSync(scratchParent)).toEqual([]);
  });

  test("an analyst prompt sets the analyst's instructions, and a failed rescore still removes the copies", async () => {
    const project = scratchDir("ralph-rejudge-");
    const source = sourceRun(project);
    const before = snapshot(source);
    const scratchParent = scratchDir("ralph-rejudge-scratch-");
    const rescore: Rescore = async (_config, options) => {
      expect(options.scoreDeps?.instructions).toEqual({ analyst: "CURRENT" });
      throw new Error("judges unavailable");
    };
    await expect(rejudgeProposal({
      project, proposal: { id: "prop-1" } as StoredProposal, runId: RUN, cases: ["c1"], kind: "analyst-prompt",
      instructions: { current: "CURRENT", proposed: "PROPOSED" },
    }, { rescore, scoreDeps: {} as never, signal: new AbortController().signal, log: () => {}, scratchParent })).rejects.toThrow("judges unavailable");
    expect(snapshot(source)).toEqual(before);
    expect(readdirSync(scratchParent)).toEqual([]);
  });
});
