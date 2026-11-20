/**
 * What a ticket the sentinel files says, and how it is filed
 * (felipearos/ralph#682, spec #678): the body around the session's draft, the
 * templated draft for an issue the sessions could not diagnose, and the one
 * tracker write.
 *
 * The gate files, never the session: the session's rails reach no tracker,
 * and code that searches before it creates is what keeps one reporter issue to
 * one ticket. The search finds the marker in the body, so a gate that died
 * between create and record — or a store lost outright — adopts the ticket it
 * already filed instead of filing a second one.
 */
import { cycleOf, TITLE_MAX_CHARS, type Draft, type IssueRecord } from "./store";
import type { Frame } from "../reporter/types";
import type { Tracker } from "../tracker/types";

/**
 * The label a sentinel ticket is filed with. Never `ready-for-agent`: the
 * ticket is a diagnosis of production by a model, so a person reads it before
 * any coder loop may take it.
 */
export const SENTINEL_LABEL = "ready-for-human";

/** At most this many frames in a templated body: enough to locate the crash, short enough to read. */
const TEMPLATED_FRAMES = 15;


/**
 * The spec's marker, for a person reading the body. A later cycle (the issue
 * came back after its ticket was closed) names its cycle, so the two tickets
 * read apart.
 */
export const sentinelMarker = (reporter: string, id: string, cycle = 0): string =>
  `<!-- ralph-sentinel: ${reporter}:${id}${cycle > 0 ? ` cycle ${cycle}` : ""} -->`;

/**
 * The marker the search uses. `findByBodyMarker` matches reliably only one
 * word of letters and digits (see its doc in `tracker/types.ts`), which the
 * spec's marker is not, so the body carries both. Closed by `end`, so issue
 * 12's token is not a prefix of issue 123's.
 *
 * Cycle 0 is exactly the token tickets were filed with before recurrences
 * (#683), so those tickets are still adopted rather than filed again. A later
 * cycle inserts `r<n>` before `end`: `…12end` is not a substring of
 * `…12r1end`, so a new cycle never adopts the closed ticket it regressed
 * after, and `…12r1end` is not a substring of `…12r10end` either.
 */
export const searchToken = (reporter: string, id: string, cycle = 0): string =>
  `ralphsentinel${reporter}${id}${cycle > 0 ? `r${cycle}` : ""}end`.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The filed body: the draft, then the reporter link and both markers. Always
 * appended, even when the session put the link in its own words — the markers
 * are what a later search finds, and the link must not depend on the session.
 * A regression leads with the closed ticket it came back after, so the
 * reader starts from the earlier diagnosis.
 */
/** The lead of a regression's ticket, in the project's language like the rest of the gate's texts. */
const REGRESSED_AFTER: Record<"en" | "es", (ref: string) => string> = {
  en: (ref) => `Regressed after ${ref}.`,
  es: (ref) => `Regresión después de ${ref}.`,
};

export function ticketBody(record: IssueRecord, draftBody: string, language: "en" | "es" = "en"): string {
  const cycle = cycleOf(record);
  const permalink = record.candidate.permalink.trim();
  const footer = [
    ...(permalink === "" ? [] : [`Sentry: ${permalink}`]),
    sentinelMarker(record.reporter, record.id, cycle),
    `<!-- ${searchToken(record.reporter, record.id, cycle)} -->`,
  ];
  const regressedAfter = typeof record.regressedAfter === "string" ? record.regressedAfter.trim() : "";
  const lead = regressedAfter === "" ? "" : `${REGRESSED_AFTER[language](regressedAfter)}\n\n`;
  return `${lead}${draftBody.trim()}\n\n${footer.join("\n")}\n`;
}

interface RecurrenceTexts {
  seenAgain: (now: RecurrenceNow, release: string) => string;
  unknown: string;
}

/** What the gate counted when the issue came back, for {@link recurrenceComment}. */
export interface RecurrenceNow {
  events: number;
  users: number;
  lastSeen: string;
  release: string | null;
  /** The events count last posted, or counted at filing. */
  baseline: number;
}

const RECURRENCE_TEXTS: Record<"en" | "es", RecurrenceTexts> = {
  en: {
    seenAgain: (now, release) =>
      `**The sentinel saw this issue again.** ${now.events} events and ${now.users} users inside the lookback (${now.baseline} events when last counted); last seen ${now.lastSeen}; release ${release}.`,
    unknown: "unknown",
  },
  es: {
    seenAgain: (now, release) =>
      `**El sentinel volvió a ver este issue.** ${now.events} eventos y ${now.users} usuarios dentro de la ventana (${now.baseline} eventos en el último conteo); visto por última vez ${now.lastSeen}; release ${release}.`,
    unknown: "desconocido",
  },
};

/** The comment the gate posts on an open ticket when its issue has at least doubled. */
export function recurrenceComment(record: IssueRecord, now: RecurrenceNow, language: "en" | "es"): string {
  const t = RECURRENCE_TEXTS[language];
  const release = now.release === null || now.release.trim() === "" ? t.unknown : now.release.trim();
  const permalink = record.candidate.permalink.trim();
  return [t.seenAgain(now, release), ...(permalink === "" ? [] : ["", `Sentry: ${permalink}`])].join("\n");
}

interface TemplateTexts {
  notDiagnosed: string;
  impact: string;
  inLookback: (events: number, users: number) => string;
  seen: (first: string, last: string) => string;
  level: (level: string, regressed: boolean) => string;
  release: (release: string) => string;
  environment: (environment: string) => string;
  frames: string;
  noFrames: string;
  moreFrames: (count: number) => string;
  noEvidence: string;
  link: string;
  noLink: string;
  unknown: string;
}

const TEMPLATE_TEXTS: Record<"en" | "es", TemplateTexts> = {
  en: {
    notDiagnosed:
      "**Not diagnosed.** The sentinel's session failed on this issue twice, so this ticket was built from the stored evidence alone; nobody has read the code yet.",
    impact: "## Impact",
    inLookback: (events, users) => `- ${events} events and ${users} users inside the lookback`,
    seen: (first, last) => `- first seen ${first}, last seen ${last}`,
    level: (level, regressed) => `- level ${level}${regressed ? ", regressed" : ", not regressed"}`,
    release: (release) => `- release: ${release}`,
    environment: (environment) => `- environment: ${environment}`,
    frames: "## Stack trace",
    noFrames: "No frames in the stored evidence.",
    moreFrames: (count) => `… ${count} more frames`,
    noEvidence: "There is no stored evidence for this issue: no release, environment or stack trace.",
    link: "## Link",
    noLink: "The reporter gave no link for this issue.",
    unknown: "unknown",
  },
  es: {
    notDiagnosed:
      "**Sin diagnóstico.** La sesión del sentinel falló dos veces con este issue, así que este ticket se armó solo con la evidencia guardada; nadie ha leído el código todavía.",
    impact: "## Impacto",
    inLookback: (events, users) => `- ${events} eventos y ${users} usuarios dentro de la ventana`,
    seen: (first, last) => `- visto por primera vez ${first}, por última vez ${last}`,
    level: (level, regressed) => `- nivel ${level}${regressed ? ", con regresión" : ", sin regresión"}`,
    release: (release) => `- release: ${release}`,
    environment: (environment) => `- entorno: ${environment}`,
    frames: "## Stack trace",
    noFrames: "La evidencia guardada no trae frames.",
    moreFrames: (count) => `… ${count} frames más`,
    noEvidence: "No hay evidencia guardada para este issue: ni release, ni entorno, ni stack trace.",
    link: "## Enlace",
    noLink: "El reporter no dio enlace para este issue.",
    unknown: "desconocido",
  },
};

const frameLine = (frame: Frame): string => `${frame.file}${frame.line === null ? "" : `:${frame.line}`} ${frame.function}`;

const singleLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The draft filed when the sessions failed on an issue twice: built from the
 * candidate and the evidence alone, and saying so first, so nobody mistakes
 * it for a diagnosis.
 */
export function templatedDraft(record: IssueRecord, language: "en" | "es", now: Date): Draft {
  const t = TEMPLATE_TEXTS[language];
  const { candidate, evidence } = record;
  const culprit = singleLine(candidate.culprit);
  let title = singleLine(culprit === "" ? candidate.title : `${candidate.title} — ${culprit}`);
  if (title.length > TITLE_MAX_CHARS) title = `${title.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;

  const lines = [
    t.notDiagnosed,
    "",
    t.impact,
    t.inLookback(candidate.events, candidate.users),
    t.seen(candidate.firstSeen, candidate.lastSeen),
    t.level(candidate.level, candidate.regressed),
  ];
  if (evidence === null) {
    lines.push("", t.noEvidence);
  } else {
    lines.push(t.release(evidence.release ?? t.unknown), t.environment(evidence.environment ?? t.unknown));
    // Stored in-app first already, but sorted again so the template never depends on that.
    const frames = [...evidence.frames.filter((frame) => frame.inApp), ...evidence.frames.filter((frame) => !frame.inApp)];
    lines.push("", t.frames);
    if (frames.length === 0) {
      lines.push(t.noFrames);
    } else {
      const shown = frames.slice(0, TEMPLATED_FRAMES);
      lines.push("```", ...shown.map(frameLine), "```");
      const more = frames.length - shown.length + evidence.framesOmitted;
      if (more > 0) lines.push(t.moreFrames(more));
    }
  }
  const permalink = candidate.permalink.trim();
  lines.push("", t.link, permalink === "" ? t.noLink : permalink);
  return { title, body: lines.join("\n"), at: now.toISOString() };
}

export type Filed = { kind: "adopted"; number: number } | { kind: "created"; number: number };

/**
 * File the ticket for one issue, or adopt the one already filed. The search
 * comes first and a hit writes nothing; a missing label throws before the
 * create, since GitHub and Linear would refuse it and Jira would invent it.
 * Tracker errors propagate: the gate catches them and leaves the issue for
 * its next pass. No retries here — the marker makes the next pass's retry
 * safe.
 */
export async function fileTicket(tracker: Tracker, record: IssueRecord, draft: Draft, language: "en" | "es" = "en"): Promise<Filed> {
  const found = await tracker.findByBodyMarker(searchToken(record.reporter, record.id, cycleOf(record)));
  if (found[0] !== undefined) return { kind: "adopted", number: found[0].number };
  const { missing } = await tracker.ensureLabels([SENTINEL_LABEL]);
  if (missing.includes(SENTINEL_LABEL)) {
    throw new Error(`the tracker has no '${SENTINEL_LABEL}' label and could not create it; refusing to file ${record.reporter}:${record.id}`);
  }
  const created = await tracker.create({ title: draft.title, body: ticketBody(record, draft.body, language), labels: [SENTINEL_LABEL] });
  return { kind: "created", number: created.number };
}
