import type { IntakeStepView, IntakeTicketView } from "../contracts";
import { HELD_STATUS, latestStep, stepLabel } from "./intake-trail";

export type IntakeSignalState = "reported" | "waiting" | "confirmed" | "working" | "blocked" | "paused" | "review" | "pr-open" | "pr-draft" | "merged" | "pr-closed" | "done" | "rejected" | "wont-do" | "deciding" | "handoff" | "unknown";
export interface IntakeSignal {
  state: IntakeSignalState;
  label: string;
  detail: string;
}

const normalize = (status: string) => status.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase().replace(/\s+/g, " ");

/** Recognize workflow names we know; keep custom names as text instead of guessing their meaning. */
function workflow(status: string | null): Omit<IntakeSignal, "detail"> {
  const value = normalize(status ?? "");
  if (["por confirmar", "pending confirmation", "awaiting confirmation"].includes(value)) return { state: "waiting", label: "Esperando confirmación" };
  // OAI's own columns for a report someone has to rule on, and one ruled out on purpose.
  if (["por decidir", "to decide", "undecided"].includes(value)) return { state: "deciding", label: "Por decidir" };
  if (["no se hace", "won't do", "wont do", "won't fix"].includes(value)) return { state: "wont-do", label: "No se hace" };
  if (["confirmado", "confirmed"].includes(value)) return { state: "confirmed", label: "Confirmado" };
  if (["bloqueado", "blocked", "impedido"].includes(value)) return { state: "blocked", label: "Bloqueado" };
  if (["pausado", "paused", "en pausa", "on hold"].includes(value)) return { state: "paused", label: "En pausa" };
  if (["en revision", "in review", "code review", "qa", "en qa", "listo para qa", "ready for qa", "testing", "en pruebas"].includes(value)) return { state: "review", label: "En revisión o pruebas" };
  if (["en curso", "en progreso", "in progress", "en desarrollo", "implementando", "working", "doing"].includes(value)) return { state: "working", label: "En curso" };
  // The clerk's own merged status (`clerk.jira.mergedStatus`, "Mergeado" on OAI).
  if (["mergeado", "merged"].includes(value)) return { state: "merged", label: "Mergeado" };
  if (["done", "resuelto", "resuelta", "resolved", "completado", "completed", "finalizado"].includes(value)) return { state: "done", label: "Resuelto" };
  if (["descartado", "rechazado", "rejected", "cancelled", "canceled", "cancelado"].includes(value)) return { state: "rejected", label: "Descartado" };
  if (["movido", "moved", "derivado", "handed off"].includes(value)) return { state: "handoff", label: "Con el equipo" };
  return { state: "unknown", label: status || "Sin estado detallado" };
}

/** What a workflow status name means on its own, apart from the ticket's trail. */
export const workflowState = (status: string | null): IntakeSignalState => workflow(status).state;

const describe = (step: IntakeStepView): string => stepLabel(step);

/** A team blocker stays visible even when Seguimiento leads with a later PR. Assignment alone never implies active work. */
export function intakeSignal(ticket: IntakeTicketView): IntakeSignal {
  const latest = latestStep(ticket.trail);
  if (latest?.kind === "pr") {
    const team = ticket.trail.filter((step) => step.kind === "team").at(-1);
    if (team?.kind === "team" && !team.held) {
      const status = workflow(team.status);
      if (status.state === "blocked" || status.state === "paused") return { ...status, detail: describe(team) };
    }
    if (latest.state === "mergeado") return { state: "merged", label: "PR mergeado", detail: describe(latest) };
    if (latest.state === "cerrado") return { state: "pr-closed", label: "PR cerrado sin merge", detail: describe(latest) };
    if (latest.state === "borrador") return { state: "pr-draft", label: "PR en borrador", detail: describe(latest) };
    return { state: "pr-open", label: "PR abierto", detail: describe(latest) };
  }
  if (latest?.kind === "team") {
    if (latest.held) return { state: "handoff", label: HELD_STATUS, detail: "El traslado al tablero OA está pendiente." };
    return { ...workflow(latest.status), detail: describe(latest) };
  }
  if (latest?.kind === "slack") return { state: "reported", label: "Reportado en Slack", detail: "Todavía no hay un ticket en el seguimiento." };
  const status = workflow(latest?.status ?? ticket.status);
  // The clerk moves a ticket to its merged status only for a merged PR that
  // names it, and that PR would lead the trail: here a person set it by hand.
  if (status.state === "merged") return { ...status, detail: `Marcado como mergeado a mano: ningún PR nombra ${ticket.key}.` };
  return { ...status, detail: latest ? describe(latest) : `${ticket.key} · ${ticket.status}` };
}
