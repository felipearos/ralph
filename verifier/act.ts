/**
 * Act mode's revert (felipearos/ralph#568, spec #560): a `revert` verdict
 * opens a revert PR for the watched merge, reopens the root ticket with the
 * same evidence so the coders fix forward, and merges the revert by the
 * project's own policy — through its normal gates where loops merge, only
 * proposed to a person where they never do.
 *
 * A PR that is itself a revert, or was already reverted, is never reverted
 * (again): it becomes an urgent ticket. So does a revert that conflicts —
 * nobody reviewed a resolution, so none is attempted.
 *
 * `reportWatch` hands the watch here with its own idempotent helpers, so every
 * step is recorded the moment it lands and a gate that dies anywhere resumes
 * with only the rest.
 */
import type { Tracker } from "../tracker/types";
import type { Gh } from "./deploys";
import { existingRevertPr, isRevert, openRevertPr, pushRevert, readPr, revertMarker, revertPrStatus, type Git } from "./revert";
import { rootOf, type Watch, type WatchReported, type WatchVerdict } from "./watches";

export interface ActDeps {
  gh: Gh;
  git: Git;
  repoRoot: string;
  baseBranch: string;
  merge: "loop" | "human";
  mergeCommand: string[] | null;
  requiredChecks: string[];
  /** How long an open revert PR may wait for green before a person is paged; default 24 h. */
  staleAfterMs?: number;
}

export const DEFAULT_STALE_AFTER_MS = 24 * 3600 * 1000;

/** `reportWatch`'s closure helpers, shared rather than copied so act mode keeps report mode's idempotency. */
export interface ActHelpers {
  tracker: Tracker;
  language: "en" | "es";
  now: () => Date;
  /** The watch's writes so far, kept current by `note`. */
  reported: WatchReported;
  wrote: string[];
  note: (patch: Partial<WatchReported>) => Promise<void>;
  step: <T>(name: string, run: () => Promise<T>) => Promise<T>;
  commentOnce: (name: string, number: number, marker: string, body: string) => Promise<void>;
  addLabel: (name: string, number: number, label: string) => Promise<void>;
  alertOnce: (subject: string, body: string) => Promise<void>;
  removeFollowing: () => Promise<void>;
  /** The settle comment on the watched ticket, posted once. */
  settle: (body: string) => Promise<void>;
  /** File (or find) the urgent fix ticket, with `extra` sections saying why it is not a revert. */
  fileFixTicket: (extra: string[]) => Promise<number>;
  /** The failed acceptance criteria and Sentry issues, rendered as the fix ticket renders them. */
  evidence: string[];
  readyLabel: string;
  /**
   * The root's reopen comment's machine line, carrying the chain, so the next
   * PR closing the root is watched at the next round. It is also the comment's
   * once-marker: it is the same line on every retry of this watch.
   */
  revertedLine: string;
}

interface ActTexts {
  prTitle: (title: string) => string;
  prIntro: (pr: number, ticketRef: string) => string;
  why: (reason: string) => string;
  reopens: (rootRef: string) => string;
  reopened: (pr: number, revertUrl: string, reason: string) => string;
  ticketReverted: (pr: number, revertUrl: string, rootRef: string) => string;
  refusedRevert: string;
  refusedTwice: (existing: string | undefined) => string;
  conflict: (files: string[], commits: string[]) => string;
  filed: (fixRef: string, reason: string) => string;
  alertTicket: (pr: number, rootRef: string) => string;
  alertProposed: (pr: number, revertPr: number, noCommand: boolean) => string;
  alertClosed: (revertPr: number) => string;
  alertRed: (revertPr: number) => string;
  alertStale: (revertPr: number) => string;
  alertFailed: (revertPr: number, error: string) => string;
  alertSubject: (pr: number, rootRef: string) => string;
  alertSubjectTicket: (pr: number, rootRef: string) => string;
}

const EN: ActTexts = {
  prTitle: (title) => `Revert "${title}"`,
  prIntro: (pr, ticketRef) => `Verifier reverts PR #${pr} (${ticketRef}): it failed in production.`,
  why: (reason) => `Why: ${reason}`,
  reopens: (rootRef) => `Reopens ${rootRef}`,
  reopened: (pr, url, reason) =>
    `Verifier reverted PR #${pr} in production and reopened this ticket so it can be fixed forward. Revert PR: ${url}\n\nWhy: ${reason}`,
  ticketReverted: (pr, url, rootRef) => `Verifier reverted PR #${pr} (${url}) and reopened ${rootRef}.`,
  refusedRevert: "Verifier did not revert it: the PR is itself a revert, and reverting a revert would put the broken change back.",
  refusedTwice: (existing) =>
    existing === undefined
      ? "Verifier did not revert it: the change is already undone on the base branch, so a revert would change nothing."
      : `Verifier did not revert it: the PR was already reverted (${existing}), and it never reverts the same PR twice.`,
  conflict: (files, commits) =>
    [
      "Verifier could not revert it: the revert conflicts with later changes, and no resolution was attempted.",
      "",
      "Conflicting files:",
      ...files.map((file) => `- ${file}`),
      "",
      "Commits in the way:",
      ...(commits.length === 0 ? ["- (none found)"] : commits),
    ].join("\n"),
  filed: (fixRef, reason) => `Verifier would have reverted this PR but could not, and filed ${fixRef} as urgent instead. ${reason}`,
  alertTicket: (pr, rootRef) => `Verifier could not revert PR #${pr} (${rootRef}) and filed an urgent ticket.`,
  alertProposed: (pr, revertPr, noCommand) =>
    `Verifier opened revert PR #${revertPr} for PR #${pr}; a person must merge it.${noCommand ? " No 'verifier.mergeCommand' is configured, so the verifier cannot merge it itself." : ""}`,
  alertClosed: (revertPr) => `Verifier's revert PR #${revertPr} was closed without merging; production still runs the change.`,
  alertRed: (revertPr) => `Verifier's revert PR #${revertPr} has failing required checks; a person must look.`,
  alertStale: (revertPr) => `Verifier's revert PR #${revertPr} has not gone green and mergeable in time; a person must look.`,
  alertFailed: (revertPr, error) => `Verifier could not merge its revert PR #${revertPr}: the merge command failed (${error}); production still runs the change.`,
  alertSubject: (pr, rootRef) => `Verifier is reverting PR #${pr} (${rootRef})`,
  alertSubjectTicket: (pr, rootRef) => `Verifier could not revert PR #${pr} (${rootRef})`,
};

const ES: ActTexts = {
  // English on purpose: `isRevert` and GitHub recognise a revert by the `Revert "` prefix.
  prTitle: (title) => `Revert "${title}"`,
  prIntro: (pr, ticketRef) => `Verifier revierte el PR #${pr} (${ticketRef}): falló en producción.`,
  why: (reason) => `Motivo: ${reason}`,
  reopens: (rootRef) => `Reabre ${rootRef}`,
  reopened: (pr, url, reason) =>
    `Verifier revirtió el PR #${pr} en producción y reabrió este ticket para corregirlo hacia adelante. PR de reversión: ${url}\n\nMotivo: ${reason}`,
  ticketReverted: (pr, url, rootRef) => `Verifier revirtió el PR #${pr} (${url}) y reabrió ${rootRef}.`,
  refusedRevert: "Verifier no lo revirtió: el PR es en sí una reversión, y revertirlo volvería a poner el cambio roto.",
  refusedTwice: (existing) =>
    existing === undefined
      ? "Verifier no lo revirtió: el cambio ya está deshecho en la rama base, así que una reversión no cambiaría nada."
      : `Verifier no lo revirtió: el PR ya fue revertido (${existing}), y nunca revierte dos veces el mismo PR.`,
  conflict: (files, commits) =>
    [
      "Verifier no pudo revertirlo: la reversión choca con cambios posteriores, y no se intentó resolver el conflicto.",
      "",
      "Archivos en conflicto:",
      ...files.map((file) => `- ${file}`),
      "",
      "Commits que lo impiden:",
      ...(commits.length === 0 ? ["- (ninguno encontrado)"] : commits),
    ].join("\n"),
  filed: (fixRef, reason) => `Verifier habría revertido este PR pero no pudo; en su lugar abrió ${fixRef} como urgente. ${reason}`,
  alertTicket: (pr, rootRef) => `Verifier no pudo revertir el PR #${pr} (${rootRef}) y abrió un ticket urgente.`,
  alertProposed: (pr, revertPr, noCommand) =>
    `Verifier abrió el PR de reversión #${revertPr} para el PR #${pr}; una persona debe mergearlo.${noCommand ? " No hay 'verifier.mergeCommand' configurado, así que verifier no puede mergearlo." : ""}`,
  alertClosed: (revertPr) => `El PR de reversión #${revertPr} se cerró sin mergear; producción sigue con el cambio.`,
  alertRed: (revertPr) => `El PR de reversión #${revertPr} tiene checks requeridos en rojo; una persona debe revisarlo.`,
  alertStale: (revertPr) => `El PR de reversión #${revertPr} no quedó en verde y mergeable a tiempo; una persona debe revisarlo.`,
  alertFailed: (revertPr, error) => `Verifier no pudo mergear el PR de reversión #${revertPr}: el comando de merge falló (${error}); producción sigue con el cambio.`,
  alertSubject: (pr, rootRef) => `Verifier está revirtiendo el PR #${pr} (${rootRef})`,
  alertSubjectTicket: (pr, rootRef) => `Verifier no pudo revertir el PR #${pr} (${rootRef})`,
};

/**
 * Advance the act revert as far as it goes. True when the watch is settled;
 * false while the revert PR waits on its checks or its merge, for the next
 * poll to look again. A failed write throws (as a `StepFailure` from `h.step`) for
 * `reportWatch` to report.
 */
export async function actRevert(watch: Watch, verdict: WatchVerdict, h: ActHelpers, act: ActDeps): Promise<boolean> {
  const { tracker, reported } = h;
  const t = h.language === "es" ? ES : EN;
  const root = rootOf(watch);
  const rootRef = tracker.ref(root);
  const subject = t.alertSubject(watch.pr, rootRef);

  // a. Decide, once: refuse, adopt, or revert.
  if (reported.revertPr === undefined && reported.revertConflict === undefined && reported.revertRefused === undefined) {
    const pr = await h.step("revert-read", () => readPr(act.gh, watch.pr));
    if (isRevert(pr)) {
      await h.note({ revertRefused: "revert" });
    } else {
      const existing = await h.step("revert-find", () => existingRevertPr(act.gh, watch.pr));
      if (existing !== null && reported.revertStartedAt === undefined) {
        // An earlier watch or a person already reverted it from the verifier's branch.
        await h.note({ revertRefused: "twice", revertUrl: existing.url });
      } else if (existing !== null) {
        // This watch's own crashed run opened it after recording its start.
        await h.note({ revertPr: existing.number, revertUrl: existing.url });
      } else {
        if (reported.revertStartedAt === undefined) await h.note({ revertStartedAt: h.now().toISOString() });
        const prepared = await h.step("revert-push", () =>
          pushRevert(
            { git: act.git, repoRoot: act.repoRoot, baseBranch: act.baseBranch },
            {
              pr: watch.pr,
              mergeCommit: watch.mergeCommit,
              message: `${t.prTitle(pr.title)}\n\nThis reverts PR #${watch.pr} (${watch.mergeCommit}): ${verdict.reason}`,
            },
          ),
        );
        if (prepared.kind === "conflict") {
          await h.note({ revertConflict: { files: prepared.files, commits: prepared.commits } });
        } else if (prepared.kind === "empty") {
          // Nothing to undo: the base already lacks the change, so it was reverted another way.
          await h.note({ revertRefused: "twice" });
        } else {
          const body = [
            t.prIntro(watch.pr, watch.ticketRef),
            t.why(verdict.reason),
            ...h.evidence,
            // Never `Closes`: merging the revert must not close the ticket it reopens.
            t.reopens(rootRef),
            revertMarker(watch.pr),
          ].join("\n\n");
          const opened = await h.step("revert-pr", () =>
            openRevertPr(act.gh, { base: act.baseBranch, branch: prepared.branch, title: t.prTitle(pr.title), body }),
          );
          h.wrote.push(`pr create #${opened.number}`);
          await h.note({ revertPr: opened.number, revertUrl: opened.url });
        }
      }
    }
  }

  // b. Refused or conflicting: an urgent ticket, not a revert.
  if (reported.revertRefused !== undefined || reported.revertConflict !== undefined) {
    const conflict = reported.revertConflict;
    const why =
      reported.revertRefused === "revert"
        ? t.refusedRevert
        : reported.revertRefused === "twice"
          ? t.refusedTwice(reported.revertUrl)
          : t.conflict(conflict!.files, conflict!.commits.map((c) => `- ${c.sha.slice(0, 7)} ${c.subject}`));
    const fix = await h.fileFixTicket([why]);
    await h.alertOnce(t.alertSubjectTicket(watch.pr, rootRef), `${t.alertTicket(watch.pr, rootRef)}\n${why}\n${tracker.url(fix)}`);
    await h.settle(t.filed(tracker.ref(fix), verdict.reason));
    await h.removeFollowing();
    return true;
  }

  const revertPr = reported.revertPr!;
  const revertUrl = reported.revertUrl ?? `#${revertPr}`;
  const settleNow = async (): Promise<boolean> => {
    await h.removeFollowing();
    return true;
  };
  /** The revert will not land: page, say so on the ticket, and end the watch with the root left closed. */
  const stop = async (outcome: "closed" | "red" | "stale" | "failed", text: string): Promise<boolean> => {
    await h.alertOnce(subject, `${text}\n${revertUrl}`);
    await h.settle(text);
    await h.note({ revertMerge: outcome });
    return settleNow();
  };

  // c. Until the revert PR's fate is known the watch stays open. The root is
  // reopened only once it merged: a coder fixing forward earlier would build
  // on a base that still holds the broken change, and the revert would land
  // under the fix.
  const ended = reported.revertMerge;
  if (ended === "closed" || ended === "red" || ended === "stale" || ended === "failed") {
    // Decided by a run that died before settling: only the settle is left.
    return settleNow();
  }
  if (ended !== "merged") {
    // Read before the first proposed alert too: an adopted revert that
    // already merged reopens the root without paging anyone.
    const status = await h.step("revert-status", () => revertPrStatus(act.gh, revertPr, act.requiredChecks));
    if (status.state === "CLOSED") return stop("closed", t.alertClosed(revertPr));
    if (status.state !== "MERGED") {
      if (status.checks === "red") return stop("red", t.alertRed(revertPr));
      const loopMerges = act.merge === "loop" && act.mergeCommand !== null;
      if (!loopMerges && ended === undefined) {
        await h.alertOnce(subject, `${t.alertProposed(watch.pr, revertPr, act.merge === "loop" && act.mergeCommand === null)}\n${revertUrl}`);
        await h.note({ revertMerge: "proposed" });
      } else if (loopMerges && ended === undefined && status.checks === "green" && status.mergeable) {
        // The verifier never merges any other way than the project's own command.
        const args = act.mergeCommand!.map((arg) => arg.replaceAll("{pr}", String(revertPr)));
        const result = await h.step("revert-merge", () => act.gh(args));
        if (!result.ok) {
          // A refused merge would be refused again every poll: a person decides.
          return stop("failed", t.alertFailed(revertPr, (result.stderr || result.stdout).trim().split("\n")[0] ?? ""));
        }
        h.wrote.push(`gh ${args.join(" ")}`);
        await h.note({ revertMerge: "requested" });
        return false;
      }
      // Pending, green but not mergeable (BLOCKED on a review), or waiting on a person.
      const since = Date.parse(reported.revertStartedAt ?? "");
      if (Number.isFinite(since) && h.now().getTime() - since > (act.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)) {
        return stop("stale", t.alertStale(revertPr));
      }
      return false;
    }
    await h.note({ revertMerge: "merged" });
  }

  // d. Reverted in production: the root goes back to the coders with the evidence.
  if (reported.rootReopenedAt === undefined) {
    const moved = await h.step("reopen", () => tracker.reopen(root));
    // A tracker that could not move the state still gets the label and the
    // comment: the label is what puts it back in front of the loops.
    h.wrote.push(moved.warning === null ? `reopen ${rootRef}` : `note reopen ${rootRef}: ${moved.warning}`);
    await h.addLabel("reopen", root, h.readyLabel);
    await h.commentOnce("reopen", root, h.revertedLine, [t.reopened(watch.pr, revertUrl, verdict.reason), ...h.evidence].join("\n\n"));
    if (watch.ticket !== root) await h.settle(t.ticketReverted(watch.pr, revertUrl, rootRef));
    await h.note({ rootReopenedAt: h.now().toISOString() });
  }
  return settleNow();
}
