// @vitest-environment node
/**
 * The canvas renderer (felipearos/ralph#319): rows in, markdown out. Pure, so
 * every rule the spec sets for the table — sections, order, the row cap and
 * its "y N más", the closed window, the header — is asserted on the text
 * itself, with no Slack in sight.
 */
import { describe, expect, it } from "vitest";

import { CLERK_JIRA_DEFAULTS, CLERK_ROW_CAP_CEILING } from "../project-config";
import { DUPLICATE_COMMENT, shadowKey, type ShadowRecord } from "./apply";
import { INTAKE_COLUMNS, appOf, cell, intakeHeader, intakeRows, renderCanvas, renderIntakeCanvas, shadowRows, type CanvasInput, type CanvasRow } from "./canvas";
import type { JiraIssue } from "./jira";
import { APP_LABELS } from "./fakes";

const SITE = "example.atlassian.net";
/** 2026-10-20 12:00 in Santiago (UTC-3). */
const NOW = Date.parse("2026-10-20T15:00:00.000Z");
const DAY = 86_400_000;

let next = 1;
const row = (over: Partial<CanvasRow> = {}): CanvasRow => {
  const key = over.key ?? `OA-${next++}`;
  return {
    key,
    url: `https://${SITE}/browse/${key}`,
    summary: `Resumen de ${key}`,
    type: "Error",
    priority: "Medium",
    difficulty: "medium",
    storyPoints: 3,
    status: "Por hacer",
    statusCategory: "new",
    labels: ["slack-intake", "Backoffice"],
    reports: 1,
    created: "2026-10-10T12:00:00.000Z",
    resolved: null,
    ...over,
  };
};

const rendered = (rows: CanvasRow[], over: Partial<CanvasInput> = {}): string =>
  renderCanvas({ apps: APP_LABELS, rows, nowMs: NOW, rowCap: 40, source: { kind: "shadow" }, ...over });

/** The body of one section: the lines between its heading and the next. */
const section = (markdown: string, title: string): string[] => {
  const lines = markdown.split("\n");
  const start = lines.indexOf(`## ${title}`);
  expect(start, `no section ${title}`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => line !== "");
};

/** The ticket keys a section's table lists, in order. */
const keys = (markdown: string, title: string): string[] =>
  section(markdown, title)
    .map((line) => /^\| \[([^\]]+)\]/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);

describe("the header", () => {
  it("says, in shadow, that the tickets come from the clerk's shadow decisions and do not exist in Jira, and when it was rebuilt", () => {
    const markdown = rendered([]);
    expect(markdown).toContain("# Reportes del canal (prueba, modo shadow)");
    expect(markdown).toContain("desde las decisiones del clerk en modo shadow: estos tickets no existen en Jira");
    expect(markdown).toContain("los cambios manuales se sobrescriben");
    expect(markdown).toContain("Actualizado: 2026-10-20 12:00 (hora de Chile).");
  });
});

describe("the sections", () => {
  it("are the four the spec names, in order, each saying so in one line when empty", () => {
    const markdown = rendered([]);
    expect(markdown.match(/^## .+$/gm)).toEqual(["## Errores abiertos", "## Pedidos abiertos", "## Por decidir", "## Cerrados en los últimos 7 días"]);
    expect(section(markdown, "Errores abiertos")).toEqual(["Sin errores abiertos."]);
    expect(section(markdown, "Pedidos abiertos")).toEqual(["Sin pedidos abiertos."]);
    expect(section(markdown, "Por decidir")).toEqual(["Nada por decidir."]);
    expect(section(markdown, "Cerrados en los últimos 7 días")).toEqual(["Sin tickets cerrados en los últimos 7 días."]);
    expect(markdown).not.toContain("|");
  });

  it("puts each ticket in exactly one: errors, requests, decisions whatever their type, and closed", () => {
    const markdown = rendered([
      row({ key: "OA-1", type: "Error" }),
      row({ key: "OA-2", type: "Tarea" }),
      row({ key: "OA-3", type: "Tarea", labels: ["slack-intake", "por-decidir"], priority: "Sin Prioridad" }),
      row({ key: "OA-4", type: "Error", labels: ["slack-intake", "por-decidir"] }),
      row({ key: "OA-5", statusCategory: "done", status: "Done", resolved: "2026-10-18T12:00:00.000Z" }),
    ]);
    expect(keys(markdown, "Errores abiertos")).toEqual(["OA-1"]);
    expect(keys(markdown, "Pedidos abiertos")).toEqual(["OA-2"]);
    expect(keys(markdown, "Por decidir")).toEqual(["OA-4", "OA-3"]);
    expect(keys(markdown, "Cerrados en los últimos 7 días")).toEqual(["OA-5"]);
  });

  it("orders open errors Highest to Low then Sin Prioridad, and the oldest first within a priority", () => {
    const markdown = rendered([
      row({ key: "OA-10", priority: "Low", created: "2026-10-01T12:00:00.000Z" }),
      row({ key: "OA-11", priority: "Sin Prioridad", created: "2026-09-01T12:00:00.000Z" }),
      row({ key: "OA-12", priority: "High", created: "2026-10-15T12:00:00.000Z" }),
      row({ key: "OA-13", priority: "Highest", created: "2026-10-19T12:00:00.000Z" }),
      row({ key: "OA-14", priority: "High", created: "2026-10-02T12:00:00.000Z" }),
      row({ key: "OA-15", priority: "Medium", created: "2026-10-03T12:00:00.000Z" }),
    ]);
    expect(keys(markdown, "Errores abiertos")).toEqual(["OA-13", "OA-14", "OA-12", "OA-15", "OA-10", "OA-11"]);
  });

  it("shows ticket, summary, app, priority, difficulty, points, status, reports and reported date for an open ticket", () => {
    const markdown = rendered([row({ key: "OA-20", summary: "No carga el panel", labels: ["slack-intake", "Backoffice", "pwa"], priority: "High", status: "LISTO PARA QA", statusCategory: "indeterminate", reports: 3, created: "2026-10-19T02:30:00.000Z" })]);
    expect(section(markdown, "Errores abiertos")).toEqual([
      "| Ticket | Resumen | App | Prioridad | Dificultad | Puntos | Estado | Reportes | Reportado |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      // 02:30 UTC on the 19th is still the 18th in Santiago.
      `| [OA-20](https://${SITE}/browse/OA-20) | No carga el panel | Backoffice, pwa | High | medium | 3 | LISTO PARA QA | 3 | 2026-10-18 |`,
    ]);
  });

  it("keeps only tickets closed in the last 7 days, most recent first, with ticket, summary, status and closed date", () => {
    const closed = (key: string, daysAgo: number) =>
      row({ key, statusCategory: "done", status: "Done", resolved: new Date(NOW - daysAgo * DAY).toISOString() });
    const markdown = rendered([closed("OA-30", 2), closed("OA-31", 8), closed("OA-32", 6.9), closed("OA-33", 0.5)]);
    const lines = section(markdown, "Cerrados en los últimos 7 días");
    expect(lines.slice(0, 2)).toEqual(["| Ticket | Resumen | Estado | Cerrado |", "| --- | --- | --- | --- |"]);
    expect(keys(markdown, "Cerrados en los últimos 7 días")).toEqual(["OA-33", "OA-30", "OA-32"]);
    expect(lines[2]).toBe(`| [OA-33](https://${SITE}/browse/OA-33) | Resumen de OA-33 | Done | 2026-10-20 |`);
    expect(markdown).not.toContain("OA-31");
  });
});

describe("the row cap", () => {
  const errors = (count: number) => Array.from({ length: count }, (_, index) => row({ key: `OA-${1000 + index}`, created: new Date(NOW - (count - index) * DAY).toISOString() }));

  it("ends a table past the cap with 'y N más', linking nothing: no search holds would-be tickets", () => {
    const markdown = rendered(errors(45), { rowCap: 40 });
    expect(keys(markdown, "Errores abiertos")).toHaveLength(40);
    expect(section(markdown, "Errores abiertos").at(-1)).toBe("y 5 más");
  });

  it("says nothing more for a table exactly at the cap", () => {
    const markdown = rendered(errors(40), { rowCap: 40 });
    expect(markdown).not.toContain("más");
  });

  it("keeps the widest table inside Slack's 300 cells at the highest cap the config allows", () => {
    const markdown = rendered(errors(100), { rowCap: CLERK_ROW_CAP_CEILING });
    const table = section(markdown, "Errores abiertos").filter((line) => line.startsWith("|") && !line.startsWith("| ---"));
    const cells = table.reduce((sum, line) => sum + line.split(/(?<!\\)\|/).length - 2, 0);
    expect(cells).toBeLessThanOrEqual(300);
  });

  it("caps the closed section too", () => {
    const closed = Array.from({ length: 3 }, (_, index) => row({ key: `OA-${2000 + index}`, statusCategory: "done", status: "Done", resolved: new Date(NOW - DAY).toISOString() }));
    const more = section(rendered(closed, { rowCap: 1 }), "Cerrados en los últimos 7 días").at(-1)!;
    expect(more).toBe("y 2 más");
  });
});

describe("cells", () => {
  it("escape a pipe and fold a newline, so a reporter's text cannot break the table", () => {
    expect(cell("a | b\nc\r\nd")).toBe("a \\| b c d");
    const markdown = rendered([row({ key: "OA-40", summary: "Columna | rota\nsegunda línea" })]);
    expect(section(markdown, "Errores abiertos")[2]).toContain("| Columna \\| rota segunda línea |");
  });

  it("carry no emoji anywhere on the canvas", () => {
    const markdown = rendered([row({ summary: "Se cae todo 🔥🔥 urgente!!! 👍🏽", status: "En curso ✅" })]);
    expect(markdown).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(markdown).toContain("| Se cae todo urgente\\!\\!\\! |");
  });

  it("show the app from the team's labels", () => {
    expect(appOf(["slack-intake", "Backoffice"], APP_LABELS)).toBe("Backoffice");
    expect(appOf(["pwa", "Backoffice"], APP_LABELS)).toBe("Backoffice, pwa");
    // The repo labels the clerk files with, beside the older ones a ticket filed by hand may carry.
    expect(appOf(["slack-intake", "acme-backoffice"], APP_LABELS)).toBe("Backoffice");
    expect(appOf(["acme-pwa"], APP_LABELS)).toBe("pwa");
    expect(appOf(["acme-pwa", "acme-backoffice", "Backoffice"], APP_LABELS)).toBe("Backoffice, pwa");
    expect(appOf(["slack-intake"], APP_LABELS)).toBe("-");
    expect(appOf(["slack-intake"], APP_LABELS)).toBe("-");
  });

  it("keep a link whole when its target holds a parenthesis or a space", () => {
    const markdown = rendered([row({ key: "OA-41", url: "https://example.com/a (b)" })]);
    expect(markdown).toContain("[OA-41](https://example.com/a%20%28b%29)");
  });
});

describe("shadow rows", () => {
  it("are the would-be tickets, open, linked to the report, counted and dated by the report", () => {
    const report = "1760961660.000100";
    const record: ShadowRecord = {
      tickets: {
        [shadowKey(report)]: {
          key: shadowKey(report),
          report,
          permalink: "https://example.slack.com/archives/C0TESTCHAN1/p1760961660000100",
          type: "Tarea",
          summary: "Agregar filtro por fecha",
          labels: ["slack-intake", "pwa", "por-decidir", "difficulty:hard", "para-persona"],
          priority: "Sin Prioridad",
          assignee: "person",
          difficulty: "hard",
          storyPoints: 5,
          createdAt: "2026-10-21T00:00:00.000Z",
          reports: 2,
        },
      },
      writes: [],
    };
    const markdown = renderCanvas({ apps: APP_LABELS, rows: shadowRows(record), nowMs: NOW, rowCap: 40, source: { kind: "shadow" } });
    expect(section(markdown, "Por decidir")[0]).toBe("| Ticket | Resumen | App | Prioridad | Dificultad | Puntos | Estado | Reportes | Reportado |");
    expect(section(markdown, "Por decidir")[2]).toBe(
      `| [${shadowKey(report)}](https://example.slack.com/archives/C0TESTCHAN1/p1760961660000100) | Agregar filtro por fecha | pwa | Sin Prioridad | hard | 5 | Sin registrar (shadow) | 2 | 2025-10-20 |`,
    );
    expect(markdown).not.toContain("atlassian");
  });

  it("show '-' for the difficulty and points of a ticket recorded before they existed, or the difficulty its label names", () => {
    const report = "1760961660.000100";
    const legacy = {
      key: shadowKey(report),
      report,
      permalink: "https://example.slack.com/archives/C0TESTCHAN1/p1760961660000100",
      type: "Error" as const,
      summary: "No exporta",
      labels: ["slack-intake", "acme-backoffice"],
      priority: "High" as const,
      createdAt: "2026-10-21T00:00:00.000Z",
      reports: 1,
    };
    expect(shadowRows({ tickets: { [legacy.key]: legacy }, writes: [] }).map((one) => [one.difficulty, one.storyPoints])).toEqual([[null, null]]);
    const labelled = { ...legacy, labels: [...legacy.labels, "difficulty:easy"] };
    expect(shadowRows({ tickets: { [legacy.key]: labelled }, writes: [] }).map((one) => [one.difficulty, one.storyPoints])).toEqual([["easy", null]]);
    const markdown = renderCanvas({ apps: APP_LABELS, rows: shadowRows({ tickets: { [legacy.key]: legacy }, writes: [] }), nowMs: NOW, rowCap: 40, source: { kind: "shadow" } });
    expect(section(markdown, "Errores abiertos")[2]).toContain("| No exporta | Backoffice | High | - | - | Sin registrar (shadow) |");
  });

  it("escape a backslash before a pipe, and brackets and bangs, so no summary breaks a row or becomes a link", () => {
    expect(cell("a\\|b")).toBe("a\\\\\\|b");
    expect(cell("ver [aquí](https://x) ![](@U1)")).toBe("ver \\[aquí\\](https://x) \\!\\[\\](@U1)");
  });
});

describe("the intake canvas (felipearos/ralph#448)", () => {
  const RULES = { site: SITE, project: "OA", statuses: CLERK_JIRA_DEFAULTS.statuses };
  const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();
  const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
    key,
    summary: `Resumen de ${key}`,
    type: "Error",
    status: "Por confirmar",
    statusCategory: "new",
    priority: "Medium",
    labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-persona"],
    created: ago(5),
    resolved: null,
    description: "Contexto\nAlgo falla.",
    comments: 0,
    doneAt: null,
    commentTexts: [],
    storyPoints: 3,
    assignee: null,
    reporter: null,
    resolution: null,
    ...over,
  });
  const closed = (key: string, days: number, over: Partial<JiraIssue> = {}): JiraIssue =>
    issue(key, { status: "Listo", statusCategory: "done", resolved: ago(days), doneAt: ago(days), ...over });
  const render = (issues: JiraIssue[], over: { rowCap?: number; site?: string } = {}): string =>
    renderIntakeCanvas({ apps: APP_LABELS, rows: intakeRows(issues, RULES), nowMs: NOW, rowCap: over.rowCap ?? 32, intakeProject: "OAI", site: over.site ?? SITE });
  const browse = (key: string): string => `[${key}](https://${SITE}/browse/${key})`;
  const head = `| ${INTAKE_COLUMNS.join(" | ")} |`;
  const rule = `| ${INTAKE_COLUMNS.map(() => "---").join(" | ")} |`;

  it("renders every section, golden: points from the field or the description line, a blank difficulty, the team's key linked", () => {
    const markdown = render([
      issue("OAI-1", {
        summary: "No carga el panel",
        priority: "High",
        created: ago(1),
        commentTexts: [`${DUPLICATE_COMMENT}Beto en Slack: https://x/p2`, "Respuesta de Ana en Slack: https://x/p3", `${DUPLICATE_COMMENT}Carla en Slack: https://x/p4`],
      }),
      // Sized only in the description (no points field configured, or the
      // field refused), and with no difficulty label at all.
      issue("OAI-2", {
        summary: "Agregar filtro por fecha",
        type: "Tarea",
        priority: null,
        labels: ["slack-intake", "acme-pwa", "para-persona"],
        storyPoints: null,
        description: "Contexto\nFalta un filtro.\n\nTipo: Tarea\nDificultad: medium\nPuntos de historia sugeridos: 5\nAsignado a: persona",
        created: ago(2),
      }),
      issue("OAI-3", { status: "Confirmado", labels: ["slack-intake", "acme-backoffice", "difficulty:easy", "para-agente", "ready-for-agent"], storyPoints: 2, created: ago(3) }),
      issue("OAI-4", { status: "En curso", statusCategory: "indeterminate", labels: ["slack-intake", "acme-pwa", "difficulty:hard", "para-agente", "rafa-wip"], storyPoints: null, created: ago(4) }),
      closed("OAI-5", 2, {
        summary: "No exporta el reporte",
        status: "Movido",
        priority: "Highest",
        labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-persona", "moved-to-jira"],
        storyPoints: 8,
        commentTexts: ["Movido a OA: OA-123"],
      }),
      closed("OAI-6", 1, { summary: "Se corrigió el login", priority: "Low", labels: ["slack-intake", "acme-backoffice", "difficulty:easy"], storyPoints: 1 }),
      closed("OAI-7", 10),
      closed("OAI-8", 3, { summary: "No es un error", status: "Descartado", labels: ["slack-intake", "acme-pwa"], storyPoints: null }),
      closed("OAI-9", 20, { status: "Descartado" }),
    ]);
    expect(markdown).toBe(
      [
        "# Reportes del canal",
        "",
        "Generado automáticamente desde el tablero de Jira OAI (tickets con la etiqueta slack-intake). No lo edites: los cambios manuales se sobrescriben en la próxima actualización.",
        "",
        "Actualizado: 2026-10-20 12:00 (hora de Chile).",
        "",
        "## Por confirmar",
        "",
        head,
        rule,
        `| ${browse("OAI-1")} | No carga el panel | Backoffice | Error | High | medium | 3 | Por confirmar | 3 |`,
        `| ${browse("OAI-2")} | Agregar filtro por fecha | pwa | Tarea | - | - | 5 | Por confirmar | 1 |`,
        "",
        "## Para agente",
        "",
        head,
        rule,
        `| ${browse("OAI-3")} | Resumen de OAI-3 | Backoffice | Error | Medium | easy | 2 | Confirmado | 1 |`,
        `| ${browse("OAI-4")} | Resumen de OAI-4 | pwa | Error | Medium | hard | - | En curso | 1 |`,
        "",
        "## En el equipo",
        "",
        "| Ticket | Resumen | App | Tipo | Prioridad | Dificultad | Puntos | Ticket del equipo | Reportes |",
        rule,
        `| ${browse("OAI-5")} | No exporta el reporte | Backoffice | Error | Highest | medium | 8 | ${browse("OA-123")} | 1 |`,
        "",
        "## Cerrados en los últimos 7 días",
        "",
        head,
        rule,
        `| ${browse("OAI-6")} | Se corrigió el login | Backoffice | Error | Low | easy | 1 | Listo | 1 |`,
        "",
        "## Descartados",
        "",
        head,
        rule,
        `| ${browse("OAI-8")} | No es un error | pwa | Error | Medium | - | - | Descartado | 1 |`,
        "",
      ].join("\n"),
    );
    expect(markdown).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("says so in every section that is empty", () => {
    const markdown = render([]);
    expect(markdown.match(/^## .+$/gm)).toEqual(["## Por confirmar", "## Para agente", "## En el equipo", "## Cerrados en los últimos 7 días", "## Descartados"]);
    for (const empty of ["Nada por confirmar.", "Nada para los agentes.", "Nada en el equipo.", "Sin tickets cerrados en los últimos 7 días.", "Sin tickets descartados en los últimos 7 días."]) {
      expect(markdown).toContain(`\n${empty}\n`);
    }
  });

  it("puts each ticket in one section: discarded over every label, moved over the agents' labels, any other open status waits for a person", () => {
    const rows = intakeRows(
      [
        closed("OAI-10", 1, { status: "Descartado", labels: ["slack-intake", "ready-for-agent", "moved-to-jira"] }),
        issue("OAI-11", { status: "Confirmado", labels: ["slack-intake", "ready-for-agent", "moved-to-jira"] }),
        issue("OAI-12", { status: "Confirmado", labels: ["slack-intake", "para-persona"] }),
        issue("OAI-13", { status: "Movido", statusCategory: "done", labels: ["slack-intake"] }),
      ],
      RULES,
    );
    expect(rows.map((row) => [row.key, row.group])).toEqual([
      ["OAI-10", "rejected"],
      ["OAI-11", "team"],
      ["OAI-12", "pending"],
      ["OAI-13", "team"],
    ]);
  });

  it("follows the configured status names", () => {
    const statuses = { ...CLERK_JIRA_DEFAULTS.statuses, rejected: "Rechazado", moved: "Trasladado" };
    const rows = intakeRows([closed("OAI-20", 1, { status: "Rechazado" }), closed("OAI-21", 1, { status: "Trasladado" }), closed("OAI-22", 1, { status: "Descartado" })], { ...RULES, statuses });
    expect(rows.map((row) => row.group)).toEqual(["rejected", "team", "closed"]);
  });

  it("keeps a key read twice once, as the later read saw it", () => {
    const rows = intakeRows([issue("OAI-30"), closed("OAI-30", 0.5)], RULES);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ group: "closed", status: "Listo" });
  });

  it("reads the points field before the description line, and the newest comment naming the team's key", () => {
    const [row] = intakeRows(
      [closed("OAI-31", 1, { status: "Movido", storyPoints: 2, description: "Puntos de historia sugeridos: 8", labels: ["slack-intake", "moved-to-jira"], commentTexts: ["Movido a OA: OA-1", "Corregido: OA-2", "OAI-99 no cuenta"] })],
      RULES,
    );
    expect(row).toMatchObject({ storyPoints: 2, teamKey: "OA-2" });
  });

  it("shows the team's key as plain text when the site is unknown, and '-' when no comment names one", () => {
    const moved = { status: "Movido", labels: ["slack-intake", "moved-to-jira"] };
    const markdown = render([issue("OAI-40", { ...moved, commentTexts: ["Movido a OA: OA-7"], created: ago(1) }), issue("OAI-41", { ...moved, created: ago(2) })], { site: "" });
    expect(markdown).toContain("| 3 | OA-7 | 1 |");
    expect(markdown).toContain("| 3 | - | 1 |");
  });

  it("escapes a cell that would break the table", () => {
    expect(render([issue("OAI-50", { summary: "Columna | rota [aquí](x)", status: "Por | confirmar" })])).toContain("| Columna \\| rota \\[aquí\\](x) | Backoffice | Error | Medium | medium | 3 | Por \\| confirmar | 1 |");
  });

  it("keeps the newest rows up to the row cap, says how many more, and stays inside Slack's 300 cells at the highest cap", () => {
    const issues = Array.from({ length: 100 }, (_, index) => issue(`OAI-${1000 + index}`, { created: new Date(NOW - (index + 1) * 60_000).toISOString() }));
    const markdown = render(issues, { rowCap: CLERK_ROW_CAP_CEILING });
    const lines = section(markdown, "Por confirmar");
    expect(keys(markdown, "Por confirmar")).toEqual(Array.from({ length: CLERK_ROW_CAP_CEILING }, (_, index) => `OAI-${1000 + index}`));
    expect(lines.at(-1)).toBe(`y ${100 - CLERK_ROW_CAP_CEILING} más`);
    const table = lines.filter((line) => line.startsWith("|") && !line.startsWith("| ---"));
    expect(table.reduce((sum, line) => sum + line.split(/(?<!\\)\|/).length - 2, 0)).toBeLessThanOrEqual(300);
  });
});

describe("the backlog link line (felipearos/ralph#459)", () => {
  const PAGE = "https://ralph-intake.example.test/p/acme-intake/intake";
  const shadow = (dashboardUrl?: string | null) =>
    renderCanvas({ apps: APP_LABELS, rows: [row()], nowMs: NOW, rowCap: CLERK_ROW_CAP_CEILING, source: { kind: "shadow" }, ...(dashboardUrl === undefined ? {} : { dashboardUrl }) });
  const board = (dashboardUrl?: string | null) =>
    renderIntakeCanvas({ apps: APP_LABELS, rows: [], nowMs: NOW, rowCap: CLERK_ROW_CAP_CEILING, intakeProject: "OAI", site: SITE, ...(dashboardUrl === undefined ? {} : { dashboardUrl }) });

  it("is the intake header's line under the title, and the shadow canvas's too, when the page is configured", () => {
    expect(intakeHeader({ apps: APP_LABELS, rows: [], nowMs: NOW, rowCap: 32, intakeProject: "OAI", site: SITE, dashboardUrl: PAGE }).slice(0, 2)).toEqual(["# Reportes del canal", `Ver todo el backlog: ${PAGE}`]);
    expect(board(PAGE).split("\n").slice(0, 4)).toEqual(["# Reportes del canal", "", `Ver todo el backlog: ${PAGE}`, ""]);
    expect(shadow(PAGE).split("\n").slice(0, 4)).toEqual(["# Reportes del canal (prueba, modo shadow)", "", `Ver todo el backlog: ${PAGE}`, ""]);
  });

  it("is left out, leaving the header as it was, when it is not", () => {
    for (const absent of [undefined, null, ""]) {
      expect(board(absent)).toBe(board());
      expect(board(absent)).not.toContain("Ver todo el backlog");
      expect(shadow(absent)).not.toContain("Ver todo el backlog");
    }
    expect(board().split("\n")[2]).toMatch(/^Generado automáticamente/);
    expect(shadow().split("\n")[2]).toMatch(/^Generado automáticamente/);
  });
});

