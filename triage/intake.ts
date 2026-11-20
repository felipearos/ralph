/**
 * The Slack intake on a keyed tracker (felipearos/ralph#396): the labels the
 * clerk and the triager speak in, and the rules of it that code can check.
 *
 * The model decides whether a report is agent-ready from the prompt's rule,
 * because readiness is a judgement about the report's prose. But four reasons
 * a report must go to a person are facts about its labels and its priority
 * line, and a plan that ignores one of them would hand a Highest-priority or
 * cross-app report to an agent overnight. So the validator enforces these
 * whatever the plan says (spec #391). Pure, no IO: the caller has the issue.
 */

/** What the clerk puts on every issue it files from a Slack report. */
export const SLACK_INTAKE_LABEL = "slack-intake";
/** The triager judged the report agent-ready; the operator has yet to approve. */
export const AGENT_PROPOSED_LABEL = "agent-proposed";
/** The triager judged the report agent-ready and `triage.autoReady` let it skip the approval. */
export const READY_FOR_AGENT_LABEL = "ready-for-agent";
/** The report went to a person, in Jira. */
export const MOVED_TO_JIRA_LABEL = "moved-to-jira";
/**
 * How a to-person decision's comment opens; the reason follows it. One copy:
 * `triage/keyed.ts` writes it and `triage/handoff.ts` reads the reason back
 * after it, so two copies drifting apart would fail every handoff.
 */
export const TO_PERSON_LEAD = "Triage: requiere una persona. ";
/** The report needs a product decision before anyone builds it. */
export const POR_DECIDIR_LABEL = "por-decidir";

/**
 * The two app repos' labels, from the project's `appLabels`. Config, not
 * constants: they are a deployment's label names, and a harness that spelled
 * one team's would carry that team's names into every other project.
 */
export interface AppLabels {
  backoffice: string;
  pwa: string;
}

/** A report carrying any of these has been triaged already. */
export const OUTCOME_LABELS = [AGENT_PROPOSED_LABEL, READY_FOR_AGENT_LABEL, MOVED_TO_JIRA_LABEL] as const;

/**
 * The plan outcomes of the Slack intake, the only ones a keyed triager has.
 * One list, because the GitHub validator refuses exactly these and the keyed
 * one allows exactly these: two copies could leave an outcome neither takes.
 */
export const KEYED_INTAKE_OUTCOMES = ["propose", "to-person"] as const;

/**
 * The labels a triager on a keyed tracker needs to exist. Preflight adds the
 * per-loop triple and the role's state labels itself, so they are not here.
 *
 * Nor are the backoffice label and `por-decidir`, though the rules read both:
 * the scope label belongs to the tracker config (`tracker.scopeLabel`) and a
 * project scoped elsewhere has no use for it, and `por-decidir` is the
 * clerk's to write, so the clerk's own preflight is what requires it.
 */
export function keyedTriagerLabels(apps: AppLabels): string[] {
  return [SLACK_INTAKE_LABEL, AGENT_PROPOSED_LABEL, READY_FOR_AGENT_LABEL, MOVED_TO_JIRA_LABEL, apps.pwa];
}

/**
 * Why a report goes to a person when the project names no `appLabels`: the
 * app rules below cannot be checked, and an unchecked report is a person's,
 * never an agent's overnight.
 */
export const NO_APP_LABELS_REASON = "Falta 'appLabels' en .ralph/config.json: sin las etiquetas de las apps no se puede revisar la app del reporte.";

/**
 * Whether an issue is a Slack report nobody has triaged yet. `scopeLabel` is
 * the project's tracker scope; null means the whole team is in scope. Open
 * state and the triage marker are the caller's to check.
 */
export function isUntriagedReport(labels: ReadonlySet<string>, scopeLabel: string | null): boolean {
  if (!labels.has(SLACK_INTAKE_LABEL)) return false;
  if (scopeLabel !== null && !labels.has(scopeLabel)) return false;
  return !OUTCOME_LABELS.some((label) => labels.has(label));
}

/**
 * A priority line as the clerk writes it: `Prioridad: Highest`,
 * `**Prioridad:** Highest`, `- Priority: High`. The colon may sit inside or
 * outside the emphasis, because markdown renderers accept both.
 */
const PRIORITY_LINE = /^\s*(?:[-*]\s+)?(?:\*{1,2})?(?:prioridad|priority)(?:\*{1,2})?\s*:(?:\*{1,2})?\s*(.*)$/i;

/** The report's priority from its body, emphasis stripped, or null when it names none. */
export function reportPriority(body: string): string | null {
  for (const line of body.split("\n")) {
    const match = PRIORITY_LINE.exec(line);
    if (match) return (match[1] ?? "").trim().replace(/^\*+|\*+$/g, "").trim();
  }
  return null;
}

/**
 * The reason, in one Spanish line, that a report must go to a person whatever
 * a plan says, or null when none applies. First match wins, so the reason a
 * reader sees is the strongest one.
 */
export function forcedToPerson(
  issue: { labels: ReadonlySet<string>; body: string },
  project: { scopeLabel: string | null; apps: AppLabels | null },
): string | null {
  if (reportPriority(issue.body)?.toLowerCase() === "highest") return "Prioridad Highest: la revisa una persona.";
  if (issue.labels.has(POR_DECIDIR_LABEL)) return "Requiere una decisión de producto (por-decidir).";
  const apps = project.apps;
  if (apps === null) return NO_APP_LABELS_REASON;
  if (issue.labels.has(apps.backoffice) && issue.labels.has(apps.pwa)) return "Afecta a las dos apps, backoffice y pwa.";
  if (issue.labels.has(apps.pwa) && project.scopeLabel !== apps.pwa) return `No hay un proyecto de agentes para ${apps.pwa}.`;
  return null;
}
