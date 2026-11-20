import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SITE, fakeJira, type FakeJira } from "../clerk/fakes";
import { jiraClient } from "../clerk/jira";
import { filedMarker } from "../clerk/live";
import type { TriageJira } from "../project-config";
import { createFakeTracker, type FakeIssue, type FakeTracker } from "../tracker/fake";
import { formatTriageMarker, triageBodyHash } from "../triage-marker";
import { opMarker } from "./body";
import { HANDOFF_LOCK_STALE_MS, acquireHandoffLock, handoffPass, type HandoffPassDeps } from "./gate";

const SCOPE = "acme-backoffice";
const PERMALINK = "https://example.slack.com/archives/C1/p1700000000000100";
const BODY = ["El botón de exportar no hace nada.", "Tipo: Error\nPrioridad: Highest\nApp: Backoffice", filedMarker(PERMALINK)].join("\n\n");

const toPerson = (unit: number, body: string): { body: string } => ({
  body: `Triage: requiere una persona. La revisa una persona.\n\n${formatTriageMarker(
    { attempt: 1, outcome: "to-person", body: triageBodyHash(body) },
    { loop: "tria", unit, op: "release-1", labels: [] },
  )}\n${opMarker("release-1")}`,
});

const report = (number: number, body = BODY): Partial<FakeIssue> & { number: number } => ({
  number,
  title: `Reporte ${number}`,
  body,
  labels: ["slack-intake", SCOPE],
  comments: [toPerson(number, body)],
});

const trackerWith = (...issues: (Partial<FakeIssue> & { number: number })[]): FakeTracker =>
  createFakeTracker({ kind: "linear", key: "AND", issues: issues as FakeIssue[] });

const RULES = (mode: TriageJira["mode"]): TriageJira => ({ mode, site: SITE, project: "OA", issueTypes: { Error: "Bug", Tarea: "Task" } });

interface Recorded {
  deps: HandoffPassDeps;
  lines: string[];
  notified: string[];
  stopped: string[];
  alerted: string[];
  released: number[];
}

function passWith(tracker: FakeTracker, mode: TriageJira["mode"], jira: FakeJira | null): Recorded {
  const lines: string[] = [];
  const notified: string[] = [];
  const stopped: string[] = [];
  const alerted: string[] = [];
  const released: number[] = [];
  return {
    lines,
    notified,
    stopped,
    alerted,
    released,
    deps: {
      tracker,
      jira: jira === null ? null : jiraClient(SITE, { email: "bot@example.com", token: "t" }, jira.fetch),
      rules: RULES(mode),
      scopeLabel: SCOPE,
      log: (line) => lines.push(line),
      notify: (denial) => notified.push(denial.code),
      stop: (denial) => stopped.push(`${denial.why}; ${denial.remedy}`),
      alert: (ref) => alerted.push(ref),
      lock: () => () => void released.push(1),
      sleep: async () => {},
      spacingMs: 0,
    },
  };
}

const creates = (jira: FakeJira) => jira.writes().filter((call) => call.path === "/rest/api/3/issue");

describe("handoffPass", () => {
  it("moves a pending report in live", async () => {
    const tracker = trackerWith(report(42));
    const jira = fakeJira();
    const pass = passWith(tracker, "live", jira);
    await handoffPass(pass.deps);
    expect(creates(jira)).toHaveLength(1);
    expect(tracker.issues.get(42)!.state).toBe("closed");
    expect(pass.lines).toEqual([expect.stringMatching(/^triage-gate: AND-42 moved to OA-\d+$/)]);
  });

  it("stops the pass on a 429, leaving the next report untouched", async () => {
    const tracker = trackerWith(report(42), report(43));
    const jira = fakeJira();
    jira.fail("/rest/api/3/search/jql", { status: 429, retryAfter: "30" });
    const pass = passWith(tracker, "live", jira);
    await handoffPass(pass.deps);
    expect(pass.lines).toHaveLength(1);
    expect(pass.lines[0]).toMatch(/^triage-gate: AND-42 waiting: /);
    expect(creates(jira)).toHaveLength(0);
    expect(tracker.issues.get(43)!.comments).toHaveLength(1);
    expect(tracker.issues.get(43)!.state).toBe("open");
  });

  it("notifies and queues one stop with the remedy on a 403, and ends the pass", async () => {
    const tracker = trackerWith(report(42), report(43));
    const jira = fakeJira();
    jira.fail("/rest/api/3/issue", { status: 403 }, { method: "POST", always: true });
    const pass = passWith(tracker, "live", jira);
    await handoffPass(pass.deps);
    expect(pass.notified).toEqual(["jira_forbidden"]);
    expect(pass.stopped).toEqual([expect.stringContaining("RALPH_CLERK_JIRA_TOKEN")]);
    expect(pass.lines).toHaveLength(1);
    expect(pass.lines[0]).toMatch(/^triage-gate: AND-42 denied: /);
    expect(tracker.issues.get(43)!.comments).toHaveLength(1);
  });

  it("uses no Jira client in shadow", async () => {
    const tracker = trackerWith(report(42));
    const jira = fakeJira();
    const pass = passWith(tracker, "shadow", jira);
    await handoffPass(pass.deps);
    expect(jira.calls).toEqual([]);
    expect(tracker.issues.get(42)!.labels).toContain("moved-to-jira");
    expect(pass.lines).toEqual(["triage-gate: AND-42 shadowed"]);
  });

  it("goes on to the next report after one fails", async () => {
    const noType = "Sin tipo.\n\nPrioridad: Highest";
    const tracker = trackerWith(report(42, noType), report(43));
    const jira = fakeJira();
    const pass = passWith(tracker, "live", jira);
    await handoffPass(pass.deps);
    expect(pass.lines).toHaveLength(2);
    expect(pass.lines[0]).toMatch(/^triage-gate: AND-42 failed: /);
    expect(pass.lines[1]).toMatch(/^triage-gate: AND-43 moved to OA-\d+$/);
    expect(creates(jira)).toHaveLength(1);
    expect(pass.notified).toEqual([]);
    // Raised, not only logged: once per pass, for the one that failed.
    expect(pass.alerted).toEqual(["AND-42"]);
  });

  it("treats a 400 as the one report's failure, alerting and going on", async () => {
    const tracker = trackerWith(report(42), report(43));
    const jira = fakeJira();
    jira.fail("/rest/api/3/issue", { status: 400 }, { method: "POST" });
    const pass = passWith(tracker, "live", jira);
    await handoffPass(pass.deps);
    expect(pass.lines[0]).toMatch(/^triage-gate: AND-42 failed: /);
    expect(pass.lines[1]).toMatch(/^triage-gate: AND-43 moved to OA-\d+$/);
    expect(pass.alerted).toEqual(["AND-42"]);
    expect(pass.notified).toEqual([]);
    expect(pass.stopped).toEqual([]);
  });

  it("releases the lock after the pass, and skips the pass while another gate holds it", async () => {
    const tracker = trackerWith(report(42));
    const jira = fakeJira();
    const pass = passWith(tracker, "live", jira);
    await handoffPass(pass.deps);
    expect(pass.released).toEqual([1]);

    const held = trackerWith(report(42));
    const blocked = passWith(held, "live", jira);
    blocked.deps.lock = () => null;
    await handoffPass(blocked.deps);
    expect(blocked.lines).toEqual(["triage-gate: another triager's gate is handing off; skipping this pass"]);
    expect(held.writes).toEqual([]);
  });
});

describe("the handoff file lock", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const lockPath = (): string => {
    dir = mkdtempSync(join(tmpdir(), "triage-lock-"));
    return join(dir, "ralph-triage-handoff.lock");
  };

  it("is exclusive while held, and release removes it", () => {
    const path = lockPath();
    const release = acquireHandoffLock(path);
    expect(release).not.toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: process.pid });
    expect(acquireHandoffLock(path)).toBeNull();
    release!();
    expect(existsSync(path)).toBe(false);
    const again = acquireHandoffLock(path);
    expect(again).not.toBeNull();
    again!();
  });

  it("takes over a lock older than the stale age", () => {
    const path = lockPath();
    const old = Date.now() - HANDOFF_LOCK_STALE_MS - 1000;
    writeFileSync(path, JSON.stringify({ pid: process.pid, at: new Date(old).toISOString() }));
    const release = acquireHandoffLock(path);
    expect(release).not.toBeNull();
    expect(Date.parse(JSON.parse(readFileSync(path, "utf8")).at)).toBeGreaterThan(old);
    release!();
  });

  it("takes over a lock whose holder is gone", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 999_999_999, at: new Date().toISOString() }));
    const release = acquireHandoffLock(path, Date.now, () => false);
    expect(release).not.toBeNull();
    release!();
  });

  it("does not take over a fresh, half-written lock", () => {
    const path = lockPath();
    writeFileSync(path, "");
    expect(acquireHandoffLock(path)).toBeNull();
    // The same file, written long ago, is stale by its age.
    const old = (Date.now() - HANDOFF_LOCK_STALE_MS - 1000) / 1000;
    utimesSync(path, old, old);
    const release = acquireHandoffLock(path);
    expect(release).not.toBeNull();
    release!();
  });
});
