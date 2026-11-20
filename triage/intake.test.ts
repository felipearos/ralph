import { describe, expect, it } from "vitest";

import { NO_APP_LABELS_REASON, OUTCOME_LABELS, forcedToPerson, isUntriagedReport, reportPriority } from "./intake";
import { APP_LABELS } from "../clerk/fakes";

const labels = (...names: string[]) => new Set(names);

describe("an untriaged report", () => {
  it("carries slack-intake and the scope label and no outcome", () => {
    expect(isUntriagedReport(labels("slack-intake", "acme-backoffice"), "acme-backoffice")).toBe(true);
    expect(isUntriagedReport(labels("acme-backoffice"), "acme-backoffice")).toBe(false);
  });

  it("is excluded by each outcome label", () => {
    for (const outcome of OUTCOME_LABELS) {
      expect(isUntriagedReport(labels("slack-intake", "acme-backoffice", outcome), "acme-backoffice")).toBe(false);
    }
  });

  it("skips the scope test when the scope label is null", () => {
    expect(isUntriagedReport(labels("slack-intake"), null)).toBe(true);
    expect(isUntriagedReport(labels("slack-intake"), "acme-backoffice")).toBe(false);
    expect(isUntriagedReport(labels("slack-intake", "acme-pwa"), "acme-backoffice")).toBe(false);
  });
});

describe("a report's priority", () => {
  it("reads the clerk's spellings", () => {
    expect(reportPriority("Resumen\nPrioridad: Highest\n")).toBe("Highest");
    expect(reportPriority("**Prioridad:** Highest")).toBe("Highest");
    expect(reportPriority("- Priority: High")).toBe("High");
    expect(reportPriority("* **prioridad**: **Low**")).toBe("Low");
  });

  it("is null when the body names none", () => {
    expect(reportPriority("Un reporte sin prioridad.\nPrioridades varias")).toBeNull();
    expect(reportPriority("")).toBeNull();
  });
});

describe("a report forced to a person", () => {
  const backoffice = { scopeLabel: "acme-backoffice", apps: APP_LABELS };

  it("names each rule", () => {
    expect(forcedToPerson({ labels: labels("acme-backoffice"), body: "Prioridad: highest" }, backoffice)).toBe(
      "Prioridad Highest: la revisa una persona.",
    );
    expect(forcedToPerson({ labels: labels("acme-backoffice", "por-decidir"), body: "" }, backoffice)).toBe(
      "Requiere una decisión de producto (por-decidir).",
    );
    expect(forcedToPerson({ labels: labels("acme-backoffice", "acme-pwa"), body: "" }, backoffice)).toBe(
      "Afecta a las dos apps, backoffice y pwa.",
    );
    expect(forcedToPerson({ labels: labels("acme-pwa"), body: "" }, backoffice)).toBe(
      "No hay un proyecto de agentes para acme-pwa.",
    );
    expect(forcedToPerson({ labels: labels("acme-pwa"), body: "" }, { scopeLabel: "acme-pwa", apps: APP_LABELS })).toBeNull();
  });

  it("gives the first rule that matches", () => {
    const all = labels("acme-backoffice", "acme-pwa", "por-decidir");
    expect(forcedToPerson({ labels: all, body: "Prioridad: Highest" }, backoffice)).toBe("Prioridad Highest: la revisa una persona.");
    expect(forcedToPerson({ labels: all, body: "Prioridad: High" }, backoffice)).toBe("Requiere una decisión de producto (por-decidir).");
    expect(forcedToPerson({ labels: labels("acme-backoffice", "acme-pwa"), body: "" }, { scopeLabel: null, apps: APP_LABELS })).toBe(
      "Afecta a las dos apps, backoffice y pwa.",
    );
  });

  it("sends every report to a person when the project names no app labels, since no app rule can be checked", () => {
    expect(forcedToPerson({ labels: labels("slack-intake", "acme-backoffice"), body: "Prioridad: High" }, { scopeLabel: "acme-backoffice", apps: null })).toBe(
      NO_APP_LABELS_REASON,
    );
    // The rules a label set alone decides still come first.
    expect(forcedToPerson({ labels: labels("por-decidir"), body: "" }, { scopeLabel: null, apps: null })).toBe("Requiere una decisión de producto (por-decidir).");
  });

  it("is null for a plain backoffice report", () => {
    expect(forcedToPerson({ labels: labels("slack-intake", "acme-backoffice"), body: "Prioridad: High" }, backoffice)).toBeNull();
  });
});
