import { describe, expect, it } from "vitest";
import type { IntakeStepView, IntakeTicketView } from "../contracts";
import { intakeSignal } from "./intake-signal-model";

const ticket = (trail: IntakeStepView[], status = "Por confirmar"): IntakeTicketView => ({
  key: "OAI-7", url: "https://example.com/OAI-7", summary: "Un reporte", app: "pwa", type: "Error",
  priority: "Medium", difficulty: "medium", storyPoints: 3, assignee: "agente", status, stage: "abierto",
  reporter: "Ana", created: null, closedAt: null, movedTo: null, movedToUrl: null, reports: 1, onCanvas: true, trail,
});
const team = (status: string | null): IntakeStepView => ({ kind: "team", key: "OA-200", url: "https://example.com/OA-200", status, held: false, at: null });
const pr = (state: "abierto" | "mergeado" | "cerrado" | "borrador"): IntakeStepView => ({ kind: "pr", repo: "o/r", number: 12, url: "https://example.com/pr/12", state, at: null });

describe("the report's status icon", () => {
  it("does not interpret assignment to an agent as active work", () => {
    expect(intakeSignal(ticket([])).state).toBe("waiting");
    expect(intakeSignal(ticket([], "Confirmado")).state).toBe("confirmed");
  });

  it("uses the current team state rather than the original intake state", () => {
    expect(intakeSignal(ticket([team("En curso")])).state).toBe("working");
    expect(intakeSignal(ticket([team("EN REVISIÓN")])).state).toBe("review");
    expect(intakeSignal(ticket([team("Resuelto")])).state).toBe("done");
  });

  it("exposes a team blocker or pause even when Seguimiento leads with a PR", () => {
    expect(intakeSignal(ticket([team("Bloqueado"), pr("abierto")]))).toEqual({ state: "blocked", label: "Bloqueado", detail: "OA-200 · Bloqueado" });
    expect(intakeSignal(ticket([team("En pausa"), pr("abierto")])).state).toBe("paused");
  });

  it("distinguishes draft, open, merged and closed-without-merge PRs", () => {
    expect(intakeSignal(ticket([pr("borrador")]))).toMatchObject({ state: "pr-draft", label: "PR en borrador" });
    expect(intakeSignal(ticket([pr("abierto")])).state).toBe("pr-open");
    expect(intakeSignal(ticket([pr("mergeado")])).label).toBe("PR mergeado");
    expect(intakeSignal(ticket([pr("cerrado")])).label).toBe("PR cerrado sin merge");
  });

  it("stays merged when a later duplicate PR is closed without merge", () => {
    const later: IntakeStepView = { kind: "pr", repo: "o/r", number: 55, url: "https://example.com/pr/55", state: "cerrado", at: null };
    expect(intakeSignal(ticket([pr("mergeado"), later])).state).toBe("merged");
  });

  it("reads the clerk's merged status, and says when no PR backs it", () => {
    const intake: IntakeStepView = { kind: "intake", key: "OAI-7", url: "https://example.com/OAI-7", status: "Mergeado", at: null };
    expect(intakeSignal(ticket([intake], "Mergeado"))).toEqual({ state: "merged", label: "Mergeado", detail: "Marcado como mergeado a mano: ningún PR nombra OAI-7." });
    expect(intakeSignal(ticket([intake, pr("mergeado")], "Mergeado"))).toMatchObject({ state: "merged", label: "PR mergeado", detail: "PR #12 · mergeado" });
  });

  it("keeps a pending handoff distinct from work already started", () => {
    expect(intakeSignal(ticket([{ kind: "team", key: null, url: null, status: null, held: true, at: null }])).state).toBe("handoff");
    expect(intakeSignal(ticket([], "Descartado")).state).toBe("rejected");
  });

  it("reads OAI's Por decidir and No se hace columns", () => {
    expect(intakeSignal(ticket([], "Por decidir"))).toMatchObject({ state: "deciding", label: "Por decidir" });
    expect(intakeSignal({ ...ticket([], "No se hace"), stage: "cerrado" })).toMatchObject({ state: "wont-do", label: "No se hace" });
  });

  it("preserves custom or missing statuses without inferring progress or success", () => {
    expect(intakeSignal(ticket([team("Esperando proveedor")]))).toEqual({ state: "unknown", label: "Esperando proveedor", detail: "OA-200 · Esperando proveedor" });
    expect(intakeSignal(ticket([team(null)])).state).toBe("unknown");
    expect(intakeSignal({ ...ticket([], "Closed"), stage: "cerrado" }).state).toBe("unknown");
  });
});
