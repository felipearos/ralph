/**
 * What the clerk does with a thread after its report is done with
 * (felipearos/ralph#321, #323). Code only, in the gate: no model turn.
 *
 * - On a FILED report — a ticket was created, or the report was a comment on
 *   the ticket it duplicated — every new reply is copied to that ticket as a
 *   Jira comment: who wrote it, what they wrote, the files they attached. The
 *   reporter's "here is another screenshot" reaches the ticket instead of
 *   dying in Slack. So does a team member's reply written BEFORE the report
 *   was filed: it is left out of the report (`clerk/reports.ts`), so the
 *   watch starts at the report's first root and skips only the replies that
 *   are in the report (`inTicket`).
 * - On an IGNORED report, a reply that mentions the clerk's bot and says "esto
 *   es un reporte" re-opens it: the report is handed over again with a hint
 *   that a person says it is a report, and the plan validator refuses `ignore`
 *   for it. Any other reply on an ignored report is left alone.
 *
 * The clerk's own messages are never copied and never count as a mention.
 * Each report remembers the newest reply it has dealt with (`copiedThrough`),
 * advanced one reply at a time after that reply's comment is written, so a
 * failed Jira write leaves the reply for a later poll, and a poll killed after
 * a comment but before the save finds the comment already there (`hasComment`
 * on the reply's permalink) rather than writing it twice.
 *
 * Threads are watched for `WATCH_DAYS` after the report was processed: one
 * history read covering that window gives every root's `latest_reply`, and
 * only a thread with something newer than `copiedThrough` is read in full.
 */
import type { ClerkRules } from "../project-config";
import { TargetGone, plain, unslack, type WritePort } from "./apply";
import { isMine, permalink, type Me } from "./reports";
import { clip } from "./plan";
import { compareTs, tsMs, type SlackMessage, type SlackReader } from "./slack";
import { queueAttachments } from "./attachments";
import { attachableFiles, attachedBlock, maxBytesOf, type AttachableFile } from "./files";
import { withClerkStore } from "./store";

/** The most of one reply a comment quotes; the whole of it is a click away in Slack. */
export const REPLY_MAX = 20_000;

/** How long a processed report's thread is watched: two weeks of follow-ups. */
export const WATCH_DAYS = 14;

/** What a person writes to the clerk to say an ignored message is a report. */
export const MENTION_PHRASE = "esto es un reporte";

/** Lower case, accents gone: "Esto ES un Reporte" and "esto es un reporté" both say it. */
const folded = (text: string): string => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Whether `message` mentions the clerk's bot and says it is a report. */
export const saysReport = (message: SlackMessage, me: Me): boolean =>
  me.userId !== "" && (message.text ?? "").includes(`<@${me.userId}`) && folded(message.text ?? "").includes(MENTION_PHRASE);

/** A reply that somebody wrote, as opposed to a join or the clerk itself. */
const written = (message: SlackMessage, me: Me): boolean =>
  !isMine(message, me) && typeof message.user === "string" && message.user !== "" && (message.subtype === undefined || message.subtype === "file_share" || message.subtype === "thread_broadcast");

/**
 * The Jira comment one copied reply becomes. Its `attachments` go onto the
 * ticket beside it and are named; any other file is linked.
 */
export function replyComment(input: {
  name: string;
  permalink: string;
  text: string;
  files: readonly string[];
  names: Readonly<Record<string, string>>;
  attachments?: readonly AttachableFile[];
  maxBytes?: number;
}): string {
  // Clipped well under Jira's 32,767 characters: one long reply must not be
  // a refusal that stops the clerk.
  const body = clip(unslack(input.text, input.names).trim(), REPLY_MAX);
  return plain(
    [
      `Respuesta de ${input.name} en Slack: ${input.permalink}`,
      body === "" ? "> (sin texto)" : body.split("\n").map((line) => `> ${line}`).join("\n"),
      ...(input.files.length === 0 ? [] : [`Adjuntos:\n${input.files.map((file) => `- ${file}`).join("\n")}`]),
      ...attachedBlock(input.attachments ?? [], input.maxBytes ?? maxBytesOf({})),
    ].join("\n\n"),
  );
}

/** Record that `report`'s threads are dealt with up to `ts`. */
async function advance(deps: ThreadDeps, report: string, ts: string): Promise<void> {
  await withClerkStore(deps.storePath, deps.rules.channel, (store) => {
    const outcome = store.processed[report];
    if (outcome !== undefined && (outcome.copiedThrough === undefined || compareTs(ts, outcome.copiedThrough) > 0)) outcome.copiedThrough = ts;
    // Past every reply already in the ticket: nothing left to skip.
    if (outcome?.inTicket !== undefined && outcome.inTicket.every((one) => compareTs(one, outcome.copiedThrough!) <= 0)) delete outcome.inTicket;
  });
}

export interface ThreadDeps {
  rules: ClerkRules;
  /** Reads alone: the watch copies replies to Jira, and posts nothing in Slack. */
  slack: Pick<SlackReader, "replies" | "userName">;
  port: WritePort;
  storePath: string;
  me: Me;
  workspaceUrl: string;
  now: () => number;
  /**
   * The OA key a filed report's intake ticket moved to, or null when it has
   * not moved: the confirmation sweep's record (`clerk/confirm.ts`). Given
   * only to a live clerk, so its thread's replies follow the ticket to the
   * team's board.
   */
  movedTo?: (key: string) => Promise<string | null>;
}

export interface Watched {
  /** Replies copied to tickets this poll (or, in shadow, recorded). */
  copied: number;
  /** Ignored reports a person asked to have filed, by report id. */
  reopened: string[];
}

/**
 * Copy new replies on filed reports, and re-open ignored reports a person
 * asked for, from `history` — the channel's top-level messages over the watch
 * window. A write that fails propagates, with every reply before it already
 * saved; the poll's own failure handling backs off and the next poll resumes.
 */
export async function watchThreads(deps: ThreadDeps, history: readonly SlackMessage[]): Promise<Watched> {
  const { rules } = deps;
  const watched = await withClerkStore(deps.storePath, rules.channel, (store) =>
    Object.entries(store.processed)
      .filter(([, outcome]) => outcome.roots !== undefined && outcome.copiedThrough !== undefined)
      // On the report's own clock, which is the clock history is read on: a
      // report processed late must not be watched past where its roots can
      // still be read.
      .filter(([id]) => deps.now() - tsMs(id) <= WATCH_DAYS * 86_400_000)
      .map(([id, outcome]) => ({ id, ...outcome })),
  );
  const byTs = new Map(history.map((message) => [message.ts, message]));
  const names = new Map<string, string>();
  const nameOf = async (user: string): Promise<string> => {
    if (!names.has(user)) {
      try {
        names.set(user, await deps.slack.userName(user));
      } catch {
        names.set(user, user);
      }
    }
    return names.get(user)!;
  };
  const result: Watched = { copied: 0, reopened: [] };
  for (const report of watched) {
    const through = report.copiedThrough!;
    const inTicket = new Set(report.inTicket ?? []);
    // Every root's new replies, merged into one timeline: a report joined from
    // two messages has two threads, and copying them root by root would skip
    // a reply in the second that is older than one already copied from the
    // first.
    const fresh: { reply: SlackMessage; root: string }[] = [];
    // The newest reply seen in any of its threads, written or not: once every
    // written one is dealt with, the report is through to here. Otherwise a
    // thread whose last word is the clerk's own reply — "Ya está reportado:
    // AND-12." — would be read again on every poll for two weeks.
    let newest = through;
    let read = false;
    for (const root of report.roots!) {
      const top = byTs.get(root);
      if (top === undefined || top.latest_reply === undefined || compareTs(top.latest_reply, through) <= 0) continue;
      read = true;
      for (const reply of await deps.slack.replies(rules.channel, root)) {
        if (reply.ts === root || compareTs(reply.ts, through) <= 0) continue;
        if (compareTs(reply.ts, newest) > 0) newest = reply.ts;
        if (written(reply, deps.me) && !inTicket.has(reply.ts)) fresh.push({ reply, root });
      }
    }
    if (!read) continue;
    fresh.sort((a, b) => compareTs(a.reply.ts, b.reply.ts));
    if (report.state === "ignored") {
      const asked = fresh.find(({ reply }) => saysReport(reply, deps.me))?.reply;
      if (asked === undefined) {
        // Seen, and nothing asked of the clerk: an ignored report's thread is
        // read only for the mention, and never copied anywhere.
        await advance(deps, report.id, newest);
        continue;
      }
      await withClerkStore(deps.storePath, rules.channel, (store) => {
        const outcome = store.processed[report.id];
        if (outcome === undefined) return;
        // Out of `processed`, into `reopened`: the next hand-over takes it
        // whatever the cursor says, and the plan may not ignore it again. The
        // outcome is kept, so a report that cannot be rebuilt goes back to
        // being ignored rather than vanishing.
        delete store.processed[report.id];
        store.reopened = {
          ...store.reopened,
          [report.id]: { by: asked.user!, at: new Date(deps.now()).toISOString(), roots: report.roots!, outcome: { ...outcome, copiedThrough: newest } },
        };
      });
      result.reopened.push(report.id);
      continue;
    }
    // Only a filed report has a ticket to copy to: the OA one its intake
    // ticket moved to, once it has. Asked only with replies in hand, so a
    // quiet thread costs no store read.
    let key = report.movedTo ?? report.key!;
    if (report.movedTo === undefined && fresh.length > 0 && deps.movedTo !== undefined) {
      const moved = await deps.movedTo(report.key!);
      if (moved !== null) {
        key = moved;
        await withClerkStore(deps.storePath, rules.channel, (store) => {
          const outcome = store.processed[report.id];
          if (outcome !== undefined) outcome.movedTo = moved;
        });
      }
    }
    for (const { reply, root } of fresh) {
      const link = permalink(deps.workspaceUrl, rules.channel, reply.ts, root);
      const name = await nameOf(reply.user!);
      // Everyone the reply mentions, so the quote reads "@Ana" rather than an id.
      for (const match of (reply.text ?? "").matchAll(/<@([A-Z0-9]+)/g)) await nameOf(match[1]!);
      const attachments = attachableFiles(reply.files);
      const named = new Set(attachments.map((file) => file.permalink));
      const body = replyComment({
        name,
        permalink: link,
        text: reply.text ?? "",
        files: (reply.files ?? [])
          .map((file) => file.permalink)
          .filter((file): file is string => typeof file === "string" && file !== "" && !named.has(file)),
        names: Object.fromEntries(names),
        attachments,
        maxBytes: maxBytesOf(rules),
      });
      try {
        if (!(await deps.port.hasComment(key, link))) {
          await deps.port.copyReply(key, body, report.id, reply.ts);
          result.copied += 1;
        }
        // The reply's files go onto the ticket beside its comment
        // (`clerk/attachments.ts` uploads them), queued before the reply is
        // marked dealt with, so a kill in between queues them again: once.
        if (attachments.length > 0) {
          await withClerkStore(deps.storePath, rules.channel, (store) => {
            queueAttachments(store, key, attachments, { mode: deps.port.mode, maxBytes: maxBytesOf(rules), report: report.id, at: new Date(deps.now()).toISOString() });
          });
        }
      } catch (error) {
        // The ticket was deleted by hand: the reply has nowhere to go, and
        // holding every later poll behind it would stop the clerk filing
        // anything for two weeks.
        if (!(error instanceof TargetGone)) throw error;
      }
      // Saved reply by reply, so a write that fails next leaves only the
      // replies after this one for a later poll.
      await advance(deps, report.id, reply.ts);
    }
    if (compareTs(newest, through) > 0) await advance(deps, report.id, newest);
  }
  return result;
}
