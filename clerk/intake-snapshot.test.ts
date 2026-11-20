// @vitest-environment node
/**
 * The intake snapshot's pure rules (felipearos/ralph#459): which rows the
 * canvas shows, how a live read is merged over the last one, the cap, and a
 * write that fails being a note rather than a throw.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  CLOSED_UNSEEN_STATUS,
  INTAKE_SNAPSHOT_MAX,
  intakeLinks,
  intakeSnapshotPath,
  mergeTickets,
  readIntakeSnapshot,
  recordIntakeSnapshot,
  shownKeys,
  boardTickets,
  shadowTickets,
  type IntakeTicket,
} from "./intake-snapshot";
import type { IntakeRow } from "./canvas";
import type { JiraIssue } from "./jira";
import type { PullRef } from "./pulls";
import { emptyShadow, shadowKey } from "./apply";
import { APP_LABELS } from "./fakes";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-intake-snapshot-"));
  dirs.push(dir);
  return dir;
};

const ticket = (key: string, over: Partial<IntakeTicket> = {}): IntakeTicket => ({
  key,
  url: `https://example.atlassian.net/browse/${key}`,
  summary: `Resumen de ${key}`,
  app: "Backoffice",
  type: "Error",
  priority: "Medium",
  difficulty: "medium",
  storyPoints: 3,
  assignee: "agente",
  status: "Todo",
  stage: "abierto",
  reporter: "Ana",
  created: "2026-10-01T12:00:00.000Z",
  closedAt: null,
  movedTo: null,
  movedToUrl: null,
  reports: 1,
  onCanvas: true,
  trail: [],
  ...over,
});

const PERMALINK = "https://example.slack.com/archives/C0TESTCHAN1/p1760961660000100";
const CREATED = "2026-10-20T15:00:00.000Z";

const row = (key: string, over: Partial<IntakeRow> = {}): IntakeRow => ({
  key,
  url: `https://example.atlassian.net/browse/${key}`,
  summary: `Resumen de ${key}`,
  type: "Error",
  priority: "Medium",
  difficulty: "medium",
  storyPoints: 3,
  status: "Por confirmar",
  labels: ["slack-intake"],
  reports: 1,
  created: CREATED,
  closedAt: null,
  teamKey: null,
  group: "pending",
  ...over,
});

const issue = (key: string, description = `Algo falla.\n\nReportado por Ana Pérez en Slack: ${PERMALINK}`): JiraIssue => ({ key, description }) as JiraIssue;

const pull = (number: number, keys: string[], over: Partial<PullRef> = {}): PullRef => ({
  repo: "example-org/acme-backoffice",
  number,
  url: `https://github.com/example-org/acme-backoffice/pull/${number}`,
  state: "abierto",
  at: "2026-10-21T12:00:00.000Z",
  keys,
  ...over,
});

describe("shownKeys", () => {
  it("reads the ticket of every table row, and nothing from headings, prose or other links", () => {
    const markdown = [
      "# Reportes del canal",
      "",
      "Ver todo el backlog: https://x.test/p/a/intake",
      "",
      "| Ticket | Resumen |",
      "| --- | --- |",
      "| [OAI-1](https://example.atlassian.net/browse/OAI-1) | Resumen con [link](https://x) |",
      "| [SHADOW-17609616600001](https://example.slack.com/archives/C0/p1) | Otro |",
      "",
      "y 3 más",
    ].join("\n");
    expect([...shownKeys(markdown)]).toEqual(["OAI-1", "SHADOW-17609616600001"]);
  });
});

describe("the trail of a board ticket", () => {
  it("is the Slack report and the intake ticket, for one that has not moved", () => {
    const [only] = boardTickets([issue("OAI-1")], [row("OAI-1")], "example.atlassian.net", new Set(), APP_LABELS);
    expect(only!.trail).toEqual([
      { kind: "slack", url: PERMALINK, at: CREATED, reporter: "Ana Pérez" },
      { kind: "intake", key: "OAI-1", url: "https://example.atlassian.net/browse/OAI-1", status: "Por confirmar", at: CREATED },
    ]);
  });

  it("has no Slack link when the description names none, and no https one is ever taken", () => {
    const [none, other] = boardTickets(
      [issue("OAI-1", "Escrito a mano."), issue("OAI-2", "Reportado por Ana en Slack: javascript:alert(1)")],
      [row("OAI-1"), row("OAI-2")],
      "example.atlassian.net",
      new Set(), APP_LABELS,
    );
    expect(none!.trail[0]).toEqual({ kind: "slack", url: null, at: CREATED, reporter: null });
    expect(other!.trail[0]).toMatchObject({ kind: "slack", url: null, reporter: "Ana" });
  });

  it("adds the team ticket a move named, with the status read, and the PRs that name either key, oldest first", () => {
    const moved = row("OAI-2", { status: "Movido", group: "team", teamKey: "OA-200", closedAt: "2026-10-21T10:00:00.000Z" });
    const pulls = [
      pull(12, ["OA-200"], { state: "mergeado", at: "2026-10-22T09:00:00.000Z" }),
      pull(11, ["OAI-2"], { state: "cerrado", at: "2026-10-21T15:00:00.000Z" }),
      pull(13, ["OAI-20", "OA-2000"]),
      pull(14, ["OA-200"], { state: "borrador", at: "2026-10-22T10:00:00.000Z" }),
    ];
    const [ticket] = boardTickets([issue("OAI-2")], [moved], "example.atlassian.net", new Set(), APP_LABELS, { teamStatuses: new Map([["OA-200", "En curso"]]), pulls });
    expect(ticket!.trail.slice(2)).toEqual([
      { kind: "team", key: "OA-200", url: "https://example.atlassian.net/browse/OA-200", status: "En curso", held: false, at: "2026-10-21T10:00:00.000Z" },
      { kind: "pr", repo: "example-org/acme-backoffice", number: 11, url: "https://github.com/example-org/acme-backoffice/pull/11", state: "cerrado", at: "2026-10-21T15:00:00.000Z" },
      { kind: "pr", repo: "example-org/acme-backoffice", number: 12, url: "https://github.com/example-org/acme-backoffice/pull/12", state: "mergeado", at: "2026-10-22T09:00:00.000Z" },
      { kind: "pr", repo: "example-org/acme-backoffice", number: 14, url: "https://github.com/example-org/acme-backoffice/pull/14", state: "borrador", at: "2026-10-22T10:00:00.000Z" },
    ]);
  });

  it("takes the team key from the sweep's record when no comment names it, and shows no status it did not read", () => {
    const [ticket] = boardTickets([issue("OAI-3")], [row("OAI-3", { status: "Movido", group: "team" })], "example.atlassian.net", new Set(), APP_LABELS, {
      movedKeys: new Map([["OAI-3", "OA-300"]]),
    });
    expect(ticket!.movedTo).toBe("OA-300");
    expect(ticket!.trail[2]).toMatchObject({ kind: "team", key: "OA-300", status: null, held: false });
  });

  it("shows a held move as pending, with no key and no link", () => {
    const byLabel = row("OAI-4", { labels: ["slack-intake", "para-mover-a-oa"], status: "Confirmado" });
    const byRecord = row("OAI-5", { status: "Confirmado" });
    const tickets = boardTickets([issue("OAI-4"), issue("OAI-5")], [byLabel, byRecord], "example.atlassian.net", new Set(), APP_LABELS, {
      movedKeys: new Map([["OAI-5", "HELD-OAI5"]]),
    });
    for (const ticket of tickets) {
      expect(ticket.movedTo).toBeNull();
      expect(ticket.trail[2]).toEqual({ kind: "team", key: null, url: null, status: null, held: true, at: null });
    }
  });
});

describe("the trail of a shadow ticket", () => {
  it("is the report's own message and the would-be ticket, which has no page", () => {
    const record = emptyShadow();
    const report = "1760961660.000100";
    const key = shadowKey(report);
    record.tickets[key] = { key, report, permalink: PERMALINK, type: "Error", summary: "Se cae", labels: ["acme-backoffice"], priority: "High" } as (typeof record.tickets)[string];
    const [ticket] = shadowTickets(record, new Set(), APP_LABELS);
    expect(ticket!.trail).toEqual([
      { kind: "slack", url: PERMALINK, at: ticket!.created, reporter: null },
      { kind: "intake", key, url: null, status: ticket!.status, at: ticket!.created },
    ]);
  });
});

describe("mergeTickets", () => {
  it("gives a ticket from a file written before the trail an empty one, not undefined", () => {
    const { trail: _dropped, ...old } = ticket("OAI-1");
    const [kept] = mergeTickets([old as IntakeTicket], [], { openComplete: false });
    expect(kept!.trail).toEqual([]);
  });

  it("replaces what was read again, keeps what was not, off the canvas", () => {
    const merged = mergeTickets([ticket("OAI-1"), ticket("OAI-2", { status: "Todo" })], [ticket("OAI-2", { status: "In Progress" })], { openComplete: false });
    expect(merged.find((entry) => entry.key === "OAI-2")).toMatchObject({ status: "In Progress", onCanvas: true });
    expect(merged.find((entry) => entry.key === "OAI-1")).toMatchObject({ stage: "abierto", onCanvas: false });
  });

  it("moves an open ticket neither read returned to Historial once the open read was whole", () => {
    const [closed] = mergeTickets([ticket("OAI-1")], [], { openComplete: true });
    expect(closed).toMatchObject({ stage: "cerrado", status: CLOSED_UNSEEN_STATUS, onCanvas: false });
    // A moved ticket keeps its stage: it is in Historial already.
    const [moved] = mergeTickets([ticket("OAI-2", { stage: "movido" })], [], { openComplete: true });
    expect(moved!.stage).toBe("movido");
  });

  it("keeps at most INTAKE_SNAPSHOT_MAX, dropping the oldest closed before any open one", () => {
    const old = (n: number, stage: IntakeTicket["stage"]) => ticket(`AND-${n}`, { stage, created: new Date(Date.UTC(2020, 0, 1) + n * 60_000).toISOString() });
    const open = Array.from({ length: 10 }, (_, n) => old(n, "abierto"));
    const closed = Array.from({ length: INTAKE_SNAPSHOT_MAX }, (_, n) => old(100 + n, "cerrado"));
    const kept = mergeTickets([], [...open, ...closed], { openComplete: false });
    expect(kept).toHaveLength(INTAKE_SNAPSHOT_MAX);
    for (const entry of open) expect(kept.map((k) => k.key)).toContain(entry.key);
    expect(kept.map((k) => k.key)).not.toContain("OAI-100");
  });
});

describe("recordIntakeSnapshot", () => {
  it("merges a live read over the last live file, and never over a shadow one", () => {
    const path = intakeSnapshotPath(join(scratch(), "clara.json"));
    expect(path).toMatch(/clara\.intake\.json$/);
    expect(recordIntakeSnapshot(path, { title: "", links: [], source: "shadow", mode: "shadow", canvasRowCap: 32, nowMs: 0, tickets: [ticket("SHADOW-1")] })).toBeNull();
    expect(recordIntakeSnapshot(path, { title: "", links: [], source: "jira", mode: "live", canvasRowCap: 32, nowMs: 1, tickets: [ticket("OAI-1")] })).toBeNull();
    expect(readIntakeSnapshot(path)!.tickets.map((entry) => entry.key)).toEqual(["OAI-1"]);
    recordIntakeSnapshot(path, { title: "", links: [], source: "jira", mode: "live", canvasRowCap: 32, nowMs: 2, tickets: [ticket("OAI-2")], openComplete: false });
    expect(readIntakeSnapshot(path)!.tickets.map((entry) => entry.key).sort()).toEqual(["OAI-1", "OAI-2"]);
  });

  it("answers a note, never a throw, when the file cannot be written", () => {
    const path = intakeSnapshotPath(join(scratch(), "clara.json"));
    mkdirSync(path);
    const note = recordIntakeSnapshot(path, { title: "", links: [], source: "shadow", mode: "shadow", canvasRowCap: 32, nowMs: 0, tickets: [] });
    expect(note).toMatch(/^intake snapshot not written to .* — .*; the page keeps the previous one$/);
  });

  it("reads a missing or garbled file as none", () => {
    expect(readIntakeSnapshot(join(scratch(), "nothing.json"))).toBeNull();
  });
});

describe("the page's shortcuts", () => {
  it("are the clerk's app repos and its two boards, from config, so the page names no team itself", () => {
    const jira = { site: "example.atlassian.net", project: "OA", intakeProject: "OAI" };
    expect(intakeLinks({ prRepos: ["example-org/acme-pwa"], jira })).toEqual([
      { group: "GitHub", label: "acme-pwa", url: "https://github.com/example-org/acme-pwa" },
      { group: "Jira", label: "Intake · OAI", url: "https://example.atlassian.net/jira/software/projects/OAI" },
      { group: "Jira", label: "Equipo · OA", url: "https://example.atlassian.net/jira/software/projects/OA" },
    ]);
  });

  it("are none for a shadow clerk with no repos and no site", () => {
    expect(intakeLinks({ prRepos: null, jira: { site: "", project: "" } })).toEqual([]);
  });
});
