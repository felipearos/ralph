import { describe, expect, it } from "vitest";

import type { IntakeMetricsRow, IntakeTicketView } from "../contracts";
import {
  ALL,
  applyFilters,
  changesOf,
  duration,
  filterOptions,
  modeNotice,
  NO_FILTERS,
  NONE,
  optionLabel,
  overridesOf,
  percent,
  reporterLabel,
  testReports,
  ticketNumbers,
  ticketsOf,
  valuableRate,
} from "./intake-model";

const ticket = (key: string, over: Partial<IntakeTicketView> = {}): IntakeTicketView => ({
  key,
  url: `https://x/${key}`,
  summary: `Resumen ${key}`,
  app: "Backoffice",
  type: "Error",
  priority: "Medium",
  difficulty: "medium",
  storyPoints: 3,
  assignee: "agente",
  status: "Por confirmar",
  stage: "abierto",
  reporter: "Ana",
  created: "2026-10-20T15:00:00.000Z",
  closedAt: null,
  movedTo: null,
  movedToUrl: null,
  reports: 1,
  onCanvas: false,
  trail: [],
  ...over,
});

const TICKETS = [
  ticket("OAI-1", { onCanvas: true }),
  ticket("OAI-2", { app: "pwa", difficulty: "hard", assignee: "persona", status: "Confirmado" }),
  ticket("OAI-3", { stage: "cerrado", status: "Done", difficulty: null, assignee: null }),
  ticket("OAI-4", {
    stage: "movido",
    status: "Movido",
    movedTo: "OA-9",
    movedToUrl: "https://x/OA-9",
    reporter: "Beto",
    trail: [
      { kind: "intake", key: "OAI-4", url: "https://x/OAI-4", status: "Movido", at: null },
      { kind: "team", key: "OA-9", url: "https://x/OA-9", status: "LISTO PARA QA", held: false, at: null },
      { kind: "pr", repo: "example-org/acme-pwa", number: 51, url: "https://gh/pull/51", state: "mergeado", at: null },
    ],
  }),
];

describe("the tabs", () => {
  it("are the canvas's rows, the open tickets, and the closed and moved ones", () => {
    expect(ticketsOf("recientes", TICKETS).map((t) => t.key)).toEqual(["OAI-1"]);
    expect(ticketsOf("backlog", TICKETS).map((t) => t.key)).toEqual(["OAI-1", "OAI-2"]);
    expect(ticketsOf("historial", TICKETS).map((t) => t.key)).toEqual(["OAI-3", "OAI-4"]);
    expect(ticketsOf("todos", TICKETS).map((t) => t.key)).toEqual(["OAI-1", "OAI-2", "OAI-3", "OAI-4"]);
  });

  it("give OAI's Por decidir and No se hace columns a tab each, by the intake ticket's own status", () => {
    const deciding = ticket("OAI-5", { status: "Por decidir" });
    const wontDo = ticket("OAI-6", { status: "No se hace", stage: "cerrado", onCanvas: false });
    const tickets = [...TICKETS, deciding, wontDo];
    expect(ticketsOf("por-decidir", tickets).map((t) => t.key)).toEqual(["OAI-5"]);
    expect(ticketsOf("no-se-hace", tickets).map((t) => t.key)).toEqual(["OAI-6"]);
    // Por decidir is still open and No se hace is closed, so each also stays in its usual tab.
    expect(ticketsOf("backlog", tickets).map((t) => t.key)).toContain("OAI-5");
    expect(ticketsOf("historial", tickets).map((t) => t.key)).toContain("OAI-6");
  });
});

describe("a ticket's numbers", () => {
  it("are its intake key, the team key it moved to and the PRs that name it, each with its link", () => {
    expect(ticketNumbers(TICKETS[3]!)).toEqual([
      { label: "OAI-4", href: "https://x/OAI-4" },
      { label: "OA-9", href: "https://x/OA-9" },
      { label: "PR #51 (acme-pwa)", href: "https://gh/pull/51" },
    ]);
  });

  it("are the intake key alone for a ticket that never left the board", () => {
    expect(ticketNumbers(TICKETS[0]!)).toEqual([{ label: "OAI-1", href: "https://x/OAI-1" }]);
  });
});

describe("the filters", () => {
  it("offer the values the tickets carry, difficulty in its own order, a missing value last", () => {
    const options = filterOptions(TICKETS);
    expect(options.difficulty).toEqual(["medium", "hard", NONE]);
    expect(options.assignee).toEqual(["agente", "persona", NONE]);
    expect(options.app).toEqual(["Backoffice", "pwa"]);
    expect(options.status).toEqual(["Confirmado", "Done", "Movido", "Por confirmar"]);
  });

  it("keep what every filter and the text match", () => {
    expect(applyFilters(TICKETS, NO_FILTERS)).toHaveLength(4);
    expect(applyFilters(TICKETS, { ...NO_FILTERS, app: "pwa" }).map((t) => t.key)).toEqual(["OAI-2"]);
    expect(applyFilters(TICKETS, { ...NO_FILTERS, difficulty: NONE }).map((t) => t.key)).toEqual(["OAI-3"]);
    expect(applyFilters(TICKETS, { ...NO_FILTERS, assignee: "agente", status: "Por confirmar" }).map((t) => t.key)).toEqual(["OAI-1"]);
    expect(applyFilters(TICKETS, { ...NO_FILTERS, text: "beto" }).map((t) => t.key)).toEqual(["OAI-4"]);
    expect(applyFilters(TICKETS, { ...NO_FILTERS, text: "oai-2" }).map((t) => t.key)).toEqual(["OAI-2"]);
    // A merged ticket is found by its team key or its PR, not only by its OAI key.
    expect(applyFilters(TICKETS, { ...NO_FILTERS, text: "oa-9" }).map((t) => t.key)).toEqual(["OAI-4"]);
    expect(applyFilters(TICKETS, { ...NO_FILTERS, text: "#51" }).map((t) => t.key)).toEqual(["OAI-4"]);
  });

  it("label values in Spanish", () => {
    expect(optionLabel("difficulty", "hard")).toBe("Difícil");
    expect(optionLabel("assignee", "persona")).toBe("Persona");
    expect(optionLabel("status", ALL)).toBe("Todos");
    expect(optionLabel("app", NONE)).toBe("Sin dato");
  });
});

const row = (over: Partial<IntakeMetricsRow> = {}): IntakeMetricsRow => ({
  key: "U1",
  reports: 4,
  valuable: 1,
  noise: 2,
  pending: 1,
  duplicates: 0,
  noiseRate: 0.5,
  confirmed: 2,
  overrideRate: 0.5,
  overridesByField: { priority: 1, storyPoints: 2 },
  overrideRateByField: { priority: 0.5, storyPoints: 1 },
  topChanges: [{ field: "storyPoints", agent: 3, human: 5, count: 2 }],
  medianConfirmLatencyMs: 90 * 60_000,
  ...over,
});

describe("the metrics", () => {
  it("read rates and latencies, and a row with nothing under a rate as a dash, never NaN", () => {
    expect(percent(0.5)).toBe("50%");
    expect(percent(null)).toBe("-");
    expect(percent(Number.NaN)).toBe("-");
    expect(valuableRate(row())).toBe("25%");
    expect(valuableRate(row({ reports: 0, valuable: 0 }))).toBe("-");
    expect(duration(null)).toBe("-");
    expect(duration(30 * 60_000)).toBe("30 min");
    expect(duration(90 * 60_000)).toBe("1.5 h");
    expect(duration(72 * 3_600_000)).toBe("3.0 d");
  });

  it("list overrides most first and the clerk-to-person changes in Spanish", () => {
    expect(overridesOf(row())).toEqual([
      { field: "Puntos", count: 2, rate: "100%" },
      { field: "Prioridad", count: 1, rate: "50%" },
    ]);
    expect(changesOf(row())).toEqual(["Puntos: 3 a 5 (2)"]);
    expect(changesOf(row({ topChanges: [{ field: "difficulty", agent: null, human: "hard", count: 1 }] }))).toEqual(["Dificultad: nada a hard (1)"]);
  });

  it("names a reporter by the recorded name, with the id", () => {
    expect(reporterLabel({ key: "U1", label: "Ana" })).toBe("Ana (U1)");
    expect(reporterLabel({ key: "U2" })).toBe("U2");
  });

  it("says how much of the numbers is test data, and what the clerk's mode means (#443)", () => {
    expect(testReports({ modes: { shadow: 0, quiet: 0, live: 7 } })).toBeNull();
    expect(testReports({ modes: { shadow: 1, quiet: 4, live: 7 } })).toBe(
      "Incluye reportes de prueba: 4 en modo quiet y 1 en modo shadow, de 12 en total. Solo los del equipo: bun clerk-metrics.ts --mode live.",
    );
    expect(modeNotice("quiet")).toContain("modo quiet");
    expect(modeNotice("shadow")).toContain("modo shadow");
    expect(modeNotice("live")).toBe("");
    expect(modeNotice(null)).toBe("");
  });
});
