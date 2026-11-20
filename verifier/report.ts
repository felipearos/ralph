/**
 * The tracker writes of the verifier's `report` mode (felipearos/ralph#567,
 * spec #560): a watched ticket is announced, then settled with its verdict,
 * and a failed verdict files a fix ticket for the loops to pick up.
 *
 * Everything goes through the `Tracker` interface, so GitHub, Linear and Jira
 * behave alike. Report mode never opens a pull request: its would-be revert
 * is a high-priority ticket and a push. Act mode's revert PR is `act.ts`'s.
 *
 * The gate runs this unattended and may die between any two writes, so every
 * write is either recorded in `watch.reported` the moment it lands or guarded
 * by a marker the next run finds on the tracker; a retry does only the rest.
 */
import type { PushInput } from "../push-notification";
import type { Tracker } from "../tracker/types";
import { actRevert, type ActDeps } from "./act";
import type { AcceptanceResult } from "./verdict";
import { rootOf, type Watch, type WatchReported, type WatchStore } from "./watches";

export interface ReportDeps {
  tracker: Tracker;
  /** Sends a push notification; the caller binds it to the project root. */
  push: (input: PushInput) => void;
  language: "en" | "es";
  now: () => Date;
  /** `owner/repo` of the watched PRs: scopes the fix-ticket marker, since two repos can share one tracker project. */
  repo: string;
  /**
   * What act mode needs to revert (#568); null or absent where it cannot, and
   * an act watch's revert verdict is then written as report mode's would-be revert.
   */
  act?: ActDeps | null;
}

export const FOLLOWING_LABEL = "following";
export const NEEDS_HUMAN_LABEL = "needs-human";
export const READY_LABEL = "ready-for-agent";
// The frontier's priority lane: a would-be revert must jump the queue.
export const URGENT_LABEL = "priority:urgent";

/**
 * One word of letters and digits, as `findByBodyMarker` needs to match it
 * reliably on every tracker. Scoped by repo, since two repos can file into one
 * Linear or Jira project, and closed by `end`, so PR #120's marker is not a
 * substring of PR #1200's.
 */
export const fixMarker = (repo: string, pr: number): string =>
  `verifierfix${repo.toLowerCase().replace(/[^a-z0-9]/g, "")}pr${pr}end`;
const watchMarker = (pr: number): string => `<!-- verifier-watch pr=${pr} -->`;
const settleMarker = (pr: number): string => `<!-- verifier-settled pr=${pr} -->`;
const summaryMarker = (root: number, pr: number): string => `<!-- verifier-needs-human root=${root} pr=${pr} -->`;
// The marker is not needed to read the chain: any repo's fix ticket continues its root's chain.
const CHAIN_LINE = /<!-- verifier-fix verifierfix[a-z0-9]+ root=(\d+) round=(\d+) lineage=(\d+(?:,\d+)*) -->/;

// What an act revert's reopen comment on the root records of its chain (#568).
const REVERTED_LINE = /<!-- verifier-reverted pr=\d+ root=(\d+) round=(\d+) lineage=(\d+(?:,\d+)*) -->/;

/** The next round of the chain `match` records, or null when it does not hold together. */
function nextRound(match: RegExpExecArray | null): { root: number; round: number; lineage: number[] } | null {
  if (match === null) return null;
  const root = Number(match[1]);
  const round = Number(match[2]);
  const lineage = match[3]!.split(",").map(Number);
  if (!Number.isSafeInteger(root) || !Number.isSafeInteger(round) || round < 1) return null;
  if (lineage.some((n) => !Number.isSafeInteger(n)) || lineage[0] !== root) return null;
  return { root, round: round + 1, lineage };
}

/** What a fix ticket's body says about its chain, or null when it is not a verifier fix ticket. */
export function chainFromBody(body: string): { root: number; round: number; lineage: number[] } | null {
  // The fix ticket's own watch is the next failure round of the same chain.
  return nextRound(CHAIN_LINE.exec(body));
}

/**
 * What an act revert's reopen comment says about the root's chain, or null
 * when the comment is not one: the next PR closing the reopened root is the
 * chain's next failure round, so revert and fix forward still hit the cap.
 */
export function chainFromRevertComment(body: string): { root: number; round: number; lineage: number[] } | null {
  return nextRound(REVERTED_LINE.exec(body));
}

/** The machine line of an act revert's reopen comment; never translated, since `chainFromRevertComment` reads it back. */
export function revertedLine(watch: Watch): string {
  const root = rootOf(watch);
  const lineage = [...watch.lineage, watch.ticket].filter((n, at, all) => all.indexOf(n) === at);
  return `<!-- verifier-reverted pr=${watch.pr} root=${root} round=${watch.round} lineage=${lineage.join(",")} -->`;
}

interface FixFacts {
  rootRef: string;
  rootUrl: string;
  round: number;
  /** Act mode tried to revert and could not, rather than report mode not being allowed to. */
  act: boolean;
  ticketRef: string;
  pr: number;
  deploy: string;
  reason: string;
}

interface SummaryRow {
  round: number;
  ticketRef: string;
  pr: number;
  outcome: string | null;
  fixRef: string | null;
}

interface Texts {
  announce: (pr: number, ticketRef: string, schedule: string[]) => string;
  settled: (verdict: "verified" | "unexercised" | "inconclusive", reason: string) => string;
  filed: (fixRef: string, reason: string, wouldRevert: boolean) => string;
  fixTitle: (ticketRef: string, pr: number, round: number, wouldRevert: boolean) => string;
  fixIntro: (facts: FixFacts, wouldRevert: boolean) => string;
  failedHeading: string;
  sentryHeading: string;
  detail: string;
  evidence: string;
  summary: (rootRef: string, rows: SummaryRow[]) => string;
  alertSubject: (rootRef: string, pr: number, needsHuman: boolean) => string;
}

const EN: Texts = {
  announce: (pr, ticketRef, schedule) =>
    [
      `Verifier is following PR #${pr} in production for ${ticketRef}.`,
      "",
      "At the first check-in it checks this ticket's acceptance criteria against production; at every check-in it reads production errors and traffic.",
      "",
      "Check-ins:",
      ...schedule.map((line) => `- ${line}`),
    ].join("\n"),
  settled: (verdict, reason) =>
    ({
      verified: `Verifier: verified in production. ${reason}`,
      unexercised: `Verifier: nothing went wrong, but production did not exercise the change. ${reason}`,
      inconclusive: `Verifier: inconclusive, production could not be observed. ${reason}`,
    })[verdict],
  filed: (fixRef, reason, wouldRevert) =>
    wouldRevert
      ? `Verifier would have reverted this PR and filed ${fixRef} as urgent instead. ${reason}`
      : `Verifier found a problem in production and filed ${fixRef}. ${reason}`,
  fixTitle: (ticketRef, pr, round, wouldRevert) =>
    wouldRevert
      ? `Urgent: verifier would have reverted PR #${pr} (${ticketRef}, round ${round})`
      : `Fix ${ticketRef} in production after PR #${pr} (round ${round})`,
  fixIntro: (f, wouldRevert) =>
    [
      wouldRevert
        ? f.act
          ? `Verifier would have reverted PR #${f.pr} but could not, so this ticket is filed as urgent instead.`
          : `Verifier would have reverted PR #${f.pr}: it runs in report mode, so this ticket is filed as urgent instead.`
        : `Verifier found a problem in production after PR #${f.pr}.`,
      "",
      `Root ticket: ${f.rootRef} (${f.rootUrl}). This is failure round ${f.round}.`,
      `Watched ticket ${f.ticketRef}, PR #${f.pr}, deploy ${f.deploy}.`,
      "",
      `Why: ${f.reason}`,
    ].join("\n"),
  failedHeading: "Failed acceptance criteria:",
  sentryHeading: "Sentry issues seen after the deploy:",
  detail: "Detail",
  evidence: "Evidence",
  summary: (rootRef, rows) =>
    [
      `Verifier stopped retrying ${rootRef}: it failed in production round after round, and a person needs to look.`,
      "",
      ...rows.map(
        (row) =>
          `- Round ${row.round}: ${row.ticketRef}, PR #${row.pr}: ${row.outcome ?? "still open"}; fix ticket: ${row.fixRef ?? "none"}`,
      ),
    ].join("\n"),
  alertSubject: (rootRef, pr, needsHuman) =>
    needsHuman ? `Verifier needs a person on ${rootRef}` : `Verifier would have reverted PR #${pr} (${rootRef})`,
};

const ES: Texts = {
  announce: (pr, ticketRef, schedule) =>
    [
      `En seguimiento: verifier revisa en producción el PR #${pr} de ${ticketRef}.`,
      "",
      "En la primera revisión comprueba en producción los criterios de aceptación de este ticket; en cada revisión mira los errores y el tráfico de producción.",
      "",
      "Revisiones:",
      ...schedule.map((line) => `- ${line}`),
    ].join("\n"),
  settled: (verdict, reason) =>
    ({
      verified: `Verifier: verificado en producción. ${reason}`,
      unexercised: `Verifier: nada falló, pero nadie usó el cambio en producción. ${reason}`,
      inconclusive: `Verifier: sin conclusión, no se pudo observar producción. ${reason}`,
    })[verdict],
  filed: (fixRef, reason, wouldRevert) =>
    wouldRevert
      ? `Verifier habría revertido este PR; en su lugar abrió ${fixRef} como urgente. ${reason}`
      : `Verifier encontró un problema en producción y abrió ${fixRef}. ${reason}`,
  fixTitle: (ticketRef, pr, round, wouldRevert) =>
    wouldRevert
      ? `Urgente: verifier habría revertido el PR #${pr} (${ticketRef}, ronda ${round})`
      : `Corregir ${ticketRef} en producción tras el PR #${pr} (ronda ${round})`,
  fixIntro: (f, wouldRevert) =>
    [
      wouldRevert
        ? f.act
          ? `Verifier habría revertido el PR #${f.pr} pero no pudo, así que abre este ticket como urgente.`
          : `Verifier habría revertido el PR #${f.pr}: funciona en modo reporte, así que abre este ticket como urgente.`
        : `Verifier encontró un problema en producción tras el PR #${f.pr}.`,
      "",
      `Ticket raíz: ${f.rootRef} (${f.rootUrl}). Esta es la ronda de fallo ${f.round}.`,
      `Ticket revisado ${f.ticketRef}, PR #${f.pr}, despliegue ${f.deploy}.`,
      "",
      `Motivo: ${f.reason}`,
    ].join("\n"),
  failedHeading: "Criterios de aceptación que fallaron:",
  sentryHeading: "Errores de Sentry vistos tras el despliegue:",
  detail: "Detalle",
  evidence: "Evidencia",
  summary: (rootRef, rows) =>
    [
      `Verifier dejó de reintentar ${rootRef}: falló en producción ronda tras ronda y necesita que una persona lo revise.`,
      "",
      ...rows.map(
        (row) =>
          `- Ronda ${row.round}: ${row.ticketRef}, PR #${row.pr}: ${row.outcome ?? "sigue abierto"}; ticket de corrección: ${row.fixRef ?? "ninguno"}`,
      ),
    ].join("\n"),
  alertSubject: (rootRef, pr, needsHuman) =>
    needsHuman ? `Verifier necesita a una persona en ${rootRef}` : `Verifier habría revertido el PR #${pr} (${rootRef})`,
};

const TEXTS: Record<"en" | "es", Texts> = { en: EN, es: ES };

/** Thrown inside a step so the caller can name where the watch stopped. */
class StepFailure extends Error {
  constructor(
    readonly step: string,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Advance one watch's report-mode writes as far as they go. Never throws. */
export async function reportWatch(
  watch: Watch,
  store: WatchStore,
  record: (patch: Partial<WatchReported>) => void | Promise<void>,
  deps: ReportDeps,
): Promise<{ wrote: string[]; error: string | null }> {
  const wrote: string[] = [];
  if (watch.mode === "observe") return { wrote, error: null };

  const { tracker, now } = deps;
  const t = TEXTS[deps.language] ?? EN;
  // A local copy, so a later step sees what an earlier one recorded even if
  // the caller's `record` does not write back into this watch object.
  const reported: WatchReported = { ...watch.reported };
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw new StepFailure(name, error);
    }
  };
  // The gate persists through the store lock, which is async; a write that
  // landed but could not be recorded stops the watch like a failed write, and
  // the next run's markers keep the retry from writing it twice.
  const note = async (patch: Partial<WatchReported>): Promise<void> => {
    Object.assign(reported, patch);
    await step("record", async () => record(patch));
  };
  const hasComment = async (name: string, number: number, marker: string): Promise<boolean> =>
    step(name, async () => (await tracker.comments(number)).some((c) => c.body.includes(marker)));
  /** Post once: a gate that died after posting finds its own marker and skips. */
  const commentOnce = async (name: string, number: number, marker: string, body: string): Promise<void> => {
    if (await hasComment(name, number, marker)) return;
    await step(name, () => tracker.comment(number, `${body}\n\n${marker}`));
    wrote.push(`comment ${tracker.ref(number)}`);
  };
  const addLabel = async (name: string, number: number, label: string): Promise<void> => {
    await step(name, () => ensured(tracker, [label]));
    await step(name, () => tracker.addLabels(number, [label]));
    wrote.push(`label+ ${tracker.ref(number)} ${label}`);
  };
  // Best-effort, and last in every settle: a watched ticket that refuses
  // edits (a Jira ticket already Done) must not keep the fix ticket, the
  // alert or the summary from landing. Its failure is reported, but the watch
  // still settles: a stale `following` label is cosmetic, and a ticket that
  // refuses edits for good would otherwise be retried every poll forever.
  let followingError: string | null = null;
  const removeFollowing = async (): Promise<void> => {
    try {
      await tracker.removeLabels(watch.ticket, [FOLLOWING_LABEL]);
      wrote.push(`label- ${tracker.ref(watch.ticket)} ${FOLLOWING_LABEL}`);
    } catch (error) {
      followingError = `following: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const alertOnce = async (needsHuman: boolean, body: string, subject?: string): Promise<void> => {
    if (reported.alerted) return;
    const root = rootOf(watch);
    await step("alert", async () =>
      deps.push({
        kind: "verifier-alert",
        occurrence: `verifier-alert:${watch.pr}`,
        priority: "high",
        ticket: root,
        subject: subject ?? t.alertSubject(tracker.ref(root), watch.pr, needsHuman),
        body,
      }),
    );
    wrote.push(`push verifier-alert:${watch.pr}`);
    await note({ alerted: true });
  };

  try {
    // A watch decided before it was ever announced goes straight to its
    // settle: the `following` label would come off at once, and a permanent
    // failure announcing must not block the fix ticket or the alert. Nothing
    // is recorded for the skipped announce; `settledAt` ends the watch's writes.
    if (reported.announcedAt === undefined && watch.verdict === null) {
      await addLabel("announce", watch.ticket, FOLLOWING_LABEL);
      const schedule = watch.checkIns.map((c) => `${utc(c.dueAt)} (+${c.offsetHours}h)`);
      await commentOnce("announce", watch.ticket, watchMarker(watch.pr), t.announce(watch.pr, watch.ticketRef, schedule));
      await note({ announcedAt: now().toISOString() });
    }

    const verdict = watch.verdict;
    if (verdict === null || reported.settledAt !== undefined) return { wrote, error: null };
    switch (verdict.verdict) {
      case "verified":
      case "unexercised":
      case "inconclusive": {
        await addLabel("settle", watch.ticket, verdict.verdict);
        await commentOnce("settle", watch.ticket, settleMarker(watch.pr), t.settled(verdict.verdict, verdict.reason));
        await removeFollowing();
        break;
      }
      case "ticket":
      case "revert": {
        if (verdict.verdict === "revert" && watch.mode === "act" && deps.act) {
          const settled = await actRevert(
            watch,
            verdict,
            {
              tracker,
              language: deps.language,
              now,
              reported,
              wrote,
              note,
              step,
              commentOnce,
              addLabel,
              alertOnce: (subject, body) => alertOnce(false, body, subject),
              removeFollowing,
              settle: (body) => commentOnce("settle", watch.ticket, settleMarker(watch.pr), body),
              fileFixTicket: (extra) => fileFixTicket(watch, reported, note, wrote, deps, t, true, step, extra, true),
              evidence: evidenceSections(watch, t),
              readyLabel: READY_LABEL,
              revertedLine: revertedLine(watch),
            },
            deps.act,
          );
          // An unsettled revert PR waiting on its checks: the next poll looks again.
          if (!settled) return { wrote, error: followingError };
          break;
        }
        // A revert act mode cannot carry out (no act deps) is written exactly
        // as report mode's would-be revert.
        const wouldRevert = verdict.verdict === "revert" || verdict.wouldHaveBeen === "revert";
        const fix = await fileFixTicket(watch, reported, note, wrote, deps, t, wouldRevert, step);
        if (wouldRevert) await alertOnce(false, t.fixTitle(watch.ticketRef, watch.pr, watch.round, true) + "\n" + tracker.url(fix));
        await commentOnce("settle", watch.ticket, settleMarker(watch.pr), t.filed(tracker.ref(fix), verdict.reason, wouldRevert));
        await removeFollowing();
        break;
      }
      case "needs-human": {
        const root = rootOf(watch);
        await addLabel("needs-human", root, NEEDS_HUMAN_LABEL);
        const summary = t.summary(tracker.ref(root), summaryRows(watch, store, tracker));
        await commentOnce("needs-human", root, summaryMarker(root, watch.pr), summary);
        await alertOnce(true, summary);
        await removeFollowing();
        break;
      }
      // "pending" is never a watch's terminal verdict; nothing to settle.
      default:
        return { wrote, error: null };
    }
    await note({ settledAt: now().toISOString() });
    return { wrote, error: followingError };
  } catch (error) {
    const failure = error instanceof StepFailure ? error : new StepFailure("report", error);
    return { wrote, error: `${failure.step}: ${failure.message}` };
  }
}

/** Ensure `labels` exist, failing by name on one the tracker could not create rather than at the write that needs it. */
async function ensured(tracker: Tracker, labels: string[]): Promise<void> {
  const { missing } = await tracker.ensureLabels(labels);
  if (missing.length > 0) throw new Error(`label ${missing.join(", ")} missing on the tracker`);
}

/** File the watch's fix ticket, or find the one an earlier run filed, and return its number. */
async function fileFixTicket(
  watch: Watch,
  reported: WatchReported,
  note: (patch: Partial<WatchReported>) => Promise<void>,
  wrote: string[],
  deps: ReportDeps,
  t: Texts,
  wouldRevert: boolean,
  step: <T>(name: string, run: () => Promise<T>) => Promise<T>,
  extra: string[] = [],
  act = false,
): Promise<number> {
  if (reported.fixTicket !== undefined) return reported.fixTicket;
  const { tracker } = deps;
  const marker = fixMarker(deps.repo, watch.pr);
  // A gate that died between create and record left the ticket behind; the
  // marker finds it, so a retry never files a second one.
  const found = await step("fix-ticket", () => tracker.findByBodyMarker(marker));
  let number = found[0]?.number;
  if (number === undefined) {
    const labels = wouldRevert ? [READY_LABEL, URGENT_LABEL] : [READY_LABEL];
    await step("fix-ticket", () => ensured(tracker, labels));
    const created = await step("fix-ticket", () =>
      tracker.create({
        title: t.fixTitle(watch.ticketRef, watch.pr, watch.round, wouldRevert),
        body: fixBody(watch, deps, t, wouldRevert, extra, act),
        labels,
      }),
    );
    number = created.number;
    wrote.push(`create ${tracker.ref(number)}`);
  }
  await note({ fixTicket: number });
  return number;
}

function fixBody(watch: Watch, deps: ReportDeps, t: Texts, wouldRevert: boolean, extra: string[], act: boolean): string {
  const { tracker } = deps;
  const root = rootOf(watch);
  const parts = [
    t.fixIntro(
      {
        rootRef: tracker.ref(root),
        rootUrl: tracker.url(root),
        round: watch.round,
        ticketRef: watch.ticketRef,
        pr: watch.pr,
        deploy: watch.deployUrl ?? watch.deployId,
        reason: watch.verdict?.reason ?? "",
        act,
      },
      wouldRevert,
    ),
    ...extra,
    ...evidenceSections(watch, t),
  ];
  // Read back by `chainFromBody` when the fix ticket's own PR is watched; never translated.
  const lineage = [...watch.lineage, watch.ticket];
  parts.push(`<!-- verifier-fix ${fixMarker(deps.repo, watch.pr)} root=${root} round=${watch.round} lineage=${lineage.join(",")} -->`);
  return parts.join("\n\n");
}

/** The failed acceptance criteria and the Sentry issues: a fix ticket's evidence, and a revert PR's. */
function evidenceSections(watch: Watch, t: Texts): string[] {
  const parts: string[] = [];
  const failed: AcceptanceResult[] = watch.checkIns.flatMap(
    (c) => c.result?.acceptance?.filter((a) => a.result === "failed" || a.result === "hard-break") ?? [],
  );
  if (failed.length > 0) {
    parts.push(
      [
        t.failedHeading,
        ...failed.map((a) =>
          [
            `- "${a.criterion}" (${a.result})`,
            ...(a.detail ? [`  ${t.detail}: ${a.detail}`] : []),
            ...(a.evidence ? [`  ${t.evidence}: ${a.evidence}`] : []),
          ].join("\n"),
        ),
      ].join("\n"),
    );
  }
  // One line per Sentry issue, however many check-ins saw it.
  const issues = new Map<string, { title: string; link?: string }>();
  for (const c of watch.checkIns) {
    for (const issue of c.result?.evidence.health.issues ?? []) {
      if (!issues.has(issue.id)) issues.set(issue.id, { title: issue.title, link: issue.link });
    }
  }
  if (issues.size > 0) {
    parts.push(
      [t.sentryHeading, ...[...issues.values()].map((i) => `- ${i.title}${i.link ? ` (${i.link})` : ""}`)].join("\n"),
    );
  }
  return parts;
}

/** Every watch of this watch's chain, by round; the watch itself as it is now, not as the snapshot saw it. */
function summaryRows(watch: Watch, store: WatchStore, tracker: Tracker): SummaryRow[] {
  const root = rootOf(watch);
  const chain = new Map<number, Watch>();
  for (const w of Object.values(store.watches)) if (rootOf(w) === root) chain.set(w.pr, w);
  chain.set(watch.pr, watch);
  return [...chain.values()]
    .sort((a, b) => a.round - b.round || a.pr - b.pr)
    .map((w) => ({
      round: w.round,
      ticketRef: w.ticketRef,
      pr: w.pr,
      outcome: w.verdict === null ? null : `${w.verdict.verdict} (${w.verdict.reason})`,
      fixRef: w.reported.fixTicket === undefined ? null : tracker.ref(w.reported.fixTicket),
    }));
}

/** `2026-10-29 14:00 UTC`: a check-in time the reader does not have to convert from ISO. */
function utc(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
