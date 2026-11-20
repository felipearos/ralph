import { describe, expect, it } from "vitest";

import type { IntakeStepView } from "../contracts";
import { HELD_STATUS, latestRank, latestStep, stepLabel, trailEntries } from "./intake-trail";

const AT = "2026-10-22T19:04:00.000Z";
const slack: IntakeStepView = { kind: "slack", url: "https://example.slack.com/archives/C0/p1", at: AT, reporter: "Ana Pérez" };
const intake: IntakeStepView = { kind: "intake", key: "OAI-7", url: "https://example.atlassian.net/browse/OAI-7", status: "Por confirmar", at: AT };
const team: IntakeStepView = { kind: "team", key: "OA-200", url: "https://example.atlassian.net/browse/OA-200", status: "En curso", held: false, at: AT };
const held: IntakeStepView = { kind: "team", key: null, url: null, status: null, held: true, at: null };
const pr = (number: number, state: "abierto" | "mergeado" | "cerrado" | "borrador"): IntakeStepView => ({
  kind: "pr",
  repo: "example-org/acme-pwa",
  number,
  url: `https://github.com/example-org/acme-pwa/pull/${number}`,
  state,
  at: AT,
});

describe("the latest stage", () => {
  it("is the furthest one: PR, then the team ticket, then the intake ticket, then the Slack report", () => {
    expect(stepLabel(latestStep([slack]))).toBe("Reporte de Slack");
    expect(stepLabel(latestStep([slack, intake]))).toBe("OAI-7 · Por confirmar");
    expect(stepLabel(latestStep([slack, intake, team]))).toBe("OA-200 · En curso");
    expect(stepLabel(latestStep([slack, intake, team, pr(12, "mergeado")]))).toBe("PR #12 · mergeado");
    // A PR on the intake key alone still outranks the intake ticket.
    expect(stepLabel(latestStep([slack, intake, pr(3, "abierto")]))).toBe("PR #3 · abierto");
    expect(stepLabel(latestStep([slack, intake, pr(4, "borrador")]))).toBe("PR #4 · borrador");
  });

  it("is the newest PR of several: the trail is oldest first", () => {
    expect(stepLabel(latestStep([slack, intake, pr(11, "cerrado"), pr(12, "abierto")]))).toBe("PR #12 · abierto");
  });

  it("keeps a merged PR over a later one closed without merge", () => {
    expect(stepLabel(latestStep([slack, intake, pr(52, "mergeado"), pr(54, "mergeado"), pr(55, "cerrado")]))).toBe("PR #54 · mergeado");
    // A newer open PR still leads: only an abandoned one is passed over.
    expect(stepLabel(latestStep([slack, intake, pr(52, "mergeado"), pr(56, "abierto")]))).toBe("PR #56 · abierto");
  });

  it("says a held move is pending, and an empty trail is a dash", () => {
    expect(stepLabel(latestStep([slack, intake, held]))).toBe(HELD_STATUS);
    expect(latestStep([])).toBeNull();
    expect(stepLabel(null)).toBe("-");
  });

  it("ranks for sorting by how far the report got", () => {
    expect([[slack, intake, team], [], [slack], [slack, pr(1, "abierto")]].map(latestRank)).toEqual([2, -1, 0, 3]);
  });
});

describe("the menu's entries", () => {
  it("list every stage, oldest first, each with its status, its Chile date and time, and its page", () => {
    expect(trailEntries([slack, intake, team, pr(12, "mergeado")])).toEqual([
      { id: "0-slack", title: "Reporte de Slack", status: "Ana Pérez", when: "22-10-2026 16:04", href: slack.url },
      { id: "1-intake", title: "Ticket en el tablero de intake (OAI-7)", status: "Por confirmar", when: "22-10-2026 16:04", href: intake.url },
      { id: "2-team", title: "Ticket en el tablero del equipo (OA-200)", status: "En curso", when: "22-10-2026 16:04", href: team.url },
      {
        id: "3-pr-example-org/acme-pwa-12",
        title: "Pull request #12 (acme-pwa)",
        status: "mergeado",
        when: "22-10-2026 16:04",
        href: "https://github.com/example-org/acme-pwa/pull/12",
      },
    ]);
  });

  it("have no link where the stage has no page: a held move, a report with no permalink, a shadow ticket", () => {
    const [report, wouldBe, pending] = trailEntries([
      { kind: "slack", url: null, at: null, reporter: null },
      { kind: "intake", key: "SHADOW-1", url: null, status: "Prueba", at: AT },
      held,
    ]);
    expect(report).toMatchObject({ href: null, status: null, when: "-" });
    expect(wouldBe).toMatchObject({ href: null, title: "Ticket en el tablero de intake (SHADOW-1)" });
    expect(pending).toEqual({ id: "2-team", title: "Ticket en el tablero del equipo", status: HELD_STATUS, when: "-", href: null });
  });
});
