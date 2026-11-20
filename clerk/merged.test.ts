// @vitest-environment node
/**
 * The merged move: a worked intake ticket a merged PR names goes to
 * `clerk.jira.mergedStatus`, and nothing else on the board moves.
 *
 * Against the fake Jira at its HTTP seam, with the store on disk.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CLERK_DEFAULTS, type ClerkRules } from "../project-config";
import { INTAKE_WORKFLOW, SITE, fakeJira, type FakeIssue, type FakeJira, type FakeWorkflow, APP_LABELS } from "./fakes";
import { jiraClient } from "./jira";
import { MERGED_WINDOW_DAYS, moveMerged, workedJql, type MergedDeps } from "./merged";
import { scanOutcomes } from "./outcomes";
import type { PullRef } from "./pulls";
import { withClerkStore } from "./store";

const CHANNEL = "C0TESTCHAN1";
const RULES: ClerkRules = {
  ...CLERK_DEFAULTS,
  appLabels: APP_LABELS,
  mode: "live",
  channel: CHANNEL,
  canvas: null,
  shadowCanvas: null,
  operator: null,
  jira: { site: SITE, project: "OA", intakeProject: "OAI", mergedStatus: "Mergeado" },
};

/** The intake board with "Mergeado" added, reachable from the work statuses. */
const WORKFLOW: FakeWorkflow = {
  statuses: [...INTAKE_WORKFLOW.statuses, { name: "Mergeado", category: "done" }],
  transitions: { ...INTAKE_WORKFLOW.transitions, "En curso": ["Listo", "Mergeado"] },
};

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const ticket = (key: string, over: Partial<FakeIssue> = {}): FakeIssue => ({
  key,
  summary: "No se puede exportar el reporte",
  status: "En curso",
  statusCategory: "indeterminate",
  labels: ["slack-intake", "acme-pwa", "para-agente", "ralph-done"],
  created: new Date().toISOString(),
  description: `Reportado en Slack: https://example.slack.com/archives/${CHANNEL}/p1760961660000000`,
  ...over,
});

const pull = (over: Partial<PullRef> = {}): PullRef => ({
  repo: "example-org/acme-pwa",
  number: 41,
  url: "https://github.com/example-org/acme-pwa/pull/41",
  state: "mergeado",
  at: new Date().toISOString(),
  keys: ["OAI-7"],
  ...over,
});

async function rig(workflow: FakeWorkflow = WORKFLOW): Promise<{ jira: FakeJira; deps: (pulls: PullRef[], over?: Partial<MergedDeps>) => MergedDeps; storePath: string }> {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-merged-"));
  roots.push(dir);
  const storePath = join(dir, "clara.json");
  await withClerkStore(storePath, CHANNEL, (store) => {
    store.cursor = "1760961600.000000";
  });
  const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: workflow } });
  const client = jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch);
  return {
    jira,
    storePath,
    deps: (pulls, over = {}) => ({ rules: RULES, jira: client, storePath, now: () => Date.now(), pulls: async () => ({ pulls, note: null }), ...over }),
  };
}

const statusOf = (jira: FakeJira, key: string): string | undefined => jira.issues.find((issue) => issue.key === key)?.status;

describe("the merged move", () => {
  it("searches the worked tickets: every status but the confirmation's and the merged one", () => {
    expect(workedJql("OAI", { pending: "Por confirmar", confirmed: "Confirmado", rejected: "Descartado", moved: "Movido" }, "Mergeado")).toBe(
      `project = "OAI" AND status not in ("Por confirmar", "Confirmado", "Descartado", "Movido", "Mergeado") AND updated >= -${MERGED_WINDOW_DAYS}d ORDER BY updated DESC`,
    );
  });

  it("moves a ticket in work to the merged status once a merged PR names it", async () => {
    const r = await rig();
    r.jira.add(ticket("OAI-7"));
    expect(await moveMerged(r.deps([pull()]))).toEqual(["OAI-7: example-org/acme-pwa#41 is merged, moved from 'En curso' to 'Mergeado'"]);
    expect(statusOf(r.jira, "OAI-7")).toBe("Mergeado");
    // Out of the next search: a rerun moves nothing twice.
    const writes = r.jira.writes().length;
    expect(await moveMerged(r.deps([pull()]))).toEqual([]);
    expect(r.jira.writes()).toHaveLength(writes);
  });

  it("moves a ticket a person already closed as done", async () => {
    const r = await rig();
    r.jira.add(ticket("OAI-7", { status: "Listo", statusCategory: "done" }));
    await moveMerged(r.deps([pull()]));
    expect(statusOf(r.jira, "OAI-7")).toBe("Mergeado");
  });

  it("leaves a ticket whose PR is open, closed or a draft", async () => {
    const r = await rig();
    r.jira.add(ticket("OAI-7"));
    for (const state of ["abierto", "cerrado", "borrador"] as const) expect(await moveMerged(r.deps([pull({ state })]))).toEqual([]);
    expect(statusOf(r.jira, "OAI-7")).toBe("En curso");
    // Nothing merged names the board, so Jira is not even read.
    expect(r.jira.calls).toEqual([]);
  });

  it("never skips a ticket past its confirmation, nor touches a rejected or moved one", async () => {
    const r = await rig();
    r.jira.add(ticket("OAI-1", { status: "Por confirmar", statusCategory: "new" }));
    r.jira.add(ticket("OAI-2", { status: "Confirmado" }));
    r.jira.add(ticket("OAI-3", { status: "Descartado", statusCategory: "done" }));
    r.jira.add(ticket("OAI-4", { status: "Movido", statusCategory: "done" }));
    expect(await moveMerged(r.deps([pull({ keys: ["OAI-1", "OAI-2", "OAI-3", "OAI-4"] })]))).toEqual([]);
    expect(r.jira.writes()).toEqual([]);
  });

  it("leaves another channel's ticket to that channel's loop", async () => {
    const r = await rig();
    r.jira.add(ticket("OAI-7", { description: "Reportado en Slack: https://example.slack.com/archives/C0OTHERCHAN/p1760961660000000" }));
    expect(await moveMerged(r.deps([pull()]))).toEqual([]);
    expect(statusOf(r.jira, "OAI-7")).toBe("En curso");
  });

  it("moves nothing when no merged status is configured", async () => {
    const r = await rig();
    r.jira.add(ticket("OAI-7"));
    const rules: ClerkRules = { ...RULES, jira: { site: SITE, project: "OA", intakeProject: "OAI" } };
    expect(await moveMerged(r.deps([pull()], { rules }))).toEqual([]);
    expect(r.jira.calls).toEqual([]);
  });

  it("notes a workflow with no way to the merged status, and keeps going", async () => {
    const r = await rig(INTAKE_WORKFLOW);
    r.jira.add(ticket("OAI-7"));
    r.jira.add(ticket("OAI-8"));
    const notes = await moveMerged(r.deps([pull({ keys: ["OAI-7", "OAI-8"] })]));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^OAI-\d: example-org\/acme-pwa#41 is merged, but OAI-\d has no transition to 'Mergeado' from 'En curso'/);
    expect(statusOf(r.jira, "OAI-7")).toBe("En curso");
  });

  it("notes a Jira or GitHub failure instead of throwing", async () => {
    const r = await rig();
    r.jira.add(ticket("OAI-7"));
    r.jira.fail("/rest/api/3/search/jql", { status: 503 });
    const [searched] = await moveMerged(r.deps([pull()]));
    expect(searched).toMatch(/^the intake board OAI could not be searched for merged tickets: .*; tried again at the next poll$/);
    const gh = await moveMerged(r.deps([], { pulls: async () => ({ pulls: [], note: "pull requests not read — gh down" }) }));
    expect(gh).toEqual(["pull requests not read — gh down"]);
    const thrown = await moveMerged(r.deps([], { pulls: async () => Promise.reject(new Error("store gone")) }));
    expect(thrown).toEqual(["the merged move failed: store gone; tried again at the next poll"]);
    expect(statusOf(r.jira, "OAI-7")).toBe("En curso");
  });

  it("closes the ticket for the outcome scan, which records it on the same poll", async () => {
    const r = await rig();
    r.jira.add(ticket("OAI-7"));
    await moveMerged(r.deps([pull()]));
    const client = jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, r.jira.fetch);
    const notes = await scanOutcomes({ rules: RULES, jira: client, storePath: r.storePath, now: () => Date.now() });
    expect(notes.some((note) => note.startsWith("OAI-7 closed in 'Mergeado'"))).toBe(true);
  });
});
