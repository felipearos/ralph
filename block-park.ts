/**
 * block-park.ts — the park a blocked session hands to `tracker.ts blocked`
 * (felipearos/ralph#776).
 *
 * A coder session that blocks on a condition a probe can watch writes
 * `.ralph/logs/block-park.json` before it runs `bun tracker.ts blocked <n>`:
 *
 *   { "ticket": 776, "condition": { "kind": "reference", "ref": "#775" },
 *     "summary": "waiting for #775 to merge", "pr": 812 }
 *
 * The blocked command records it in the park store (`park-store.ts`) once the
 * label swap succeeded, so the park probe (#775) can wake the ticket without a
 * session. The file is always deleted once read: it is one iteration's
 * hand-off, never the next one's. Nothing here throws — the label swap has
 * already happened and must stand whatever becomes of the park.
 */
import { readFileSync, unlinkSync } from "node:fs";

import { budgetHours, listStore, park, unpark, validateParkInput, withStore, type ParkInput } from "./park-store";

export interface BlockParkDeps {
  /** The hand-off file the session wrote. */
  file: string;
  /** The park store to record into. */
  storePath: string;
  now?: () => string;
  log: (line: string) => void;
  /** Sends a notification; argv is `push-notification.ts`'s. */
  push: (argv: string[]) => void;
  env?: Record<string, string | undefined>;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function remove(path: string): void {
  try { unlinkSync(path); } catch {
    // ENOENT or anything else: a stale file is refused next time by its ticket
  }
}

/** The park the file describes for `ticket`, or why it is refused. */
function parseHandOff(raw: string, ticket: number, loop: string): ParkInput | string {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return "it is not JSON"; }
  if (!isRecord(value)) return "it is not a JSON object";
  if (value.ticket !== ticket) return `it names ticket ${JSON.stringify(value.ticket)}, not #${ticket}`;
  if (typeof value.summary !== "string" || !value.summary.trim()) return "its summary is empty";
  const pr = value.pr ?? null;
  return validateParkInput({
    ticket,
    loop,
    label: `${loop}-blocked`,
    pr: pr as number | null,
    condition: value.condition as ParkInput["condition"],
    summary: value.summary,
  });
}

/**
 * Record the park the session handed off for `ticket`, if it wrote one. A
 * missing file is nothing to do: the session wrote none, so it pushed high.
 * A file that is present is the session saying it pushed at normal, trusting
 * the park, so ANY way the park does not land — a file refused after
 * `park-store.ts check` passed (another ticket, an empty summary, a dropped
 * `pr`), or a write that fails — is pushed high here. Otherwise the ticket
 * would sit blocked with a normal page and no park to expire.
 */
export async function recordBlockPark(input: { ticket: number; loop: string }, deps: BlockParkDeps): Promise<void> {
  const { ticket, loop } = input;
  let raw: string;
  try { raw = readFileSync(deps.file, "utf8"); } catch {
    // No hand-off: this block names no condition. A park left from an earlier
    // block of the same ticket must not outlive it, or the probe would wake
    // the ticket on the old condition and rescue would skip it for a wait
    // nobody is in. Read first, so a ticket that was never parked writes nothing.
    try {
      // Only this loop's park of it: the store sits in git's common dir, and a
      // same-numbered ticket of another project there is not this one.
      if (listStore(deps.storePath).some((record) => record.ticket === ticket && record.label === `${loop}-blocked`)) {
        await withStore(deps.storePath, (store) => unpark(store, ticket));
        deps.log(`block-park: #${ticket} blocked with no condition; its earlier park is dropped`);
      }
    } catch (error) {
      try { deps.log(`block-park: #${ticket} its earlier park could not be dropped: ${message(error)}`); } catch {
        // the logger itself failed: nothing is left to report to, and the label swap stands
      }
    }
    return;
  }
  const pushHigh = (occurrence: string, body: string): void => {
    try {
      deps.push([
        "push", "--kind", "ticket-blocked", "--priority", "high", "--ticket", String(ticket),
        "--occurrence", `${occurrence}:${ticket}:${since()}`, // Not "Ticket #n blocked": the push is mirrored as a comment headed by
        // its subject, and that heading is a block record (`block-reason.ts`),
        // which would replace the session's own needs-migration or blocked line.
        "--subject", `Ticket #${ticket} park not recorded`,
        "--body", body,
      ]);
    } catch (pushError) {
      deps.log(`block-park: #${ticket} the high-priority push failed: ${message(pushError)}`);
    }
  };
  let stamp: string | null = null;
  const since = (): string => (stamp ??= (deps.now ?? (() => new Date().toISOString()))());
  try {
    const parsed = parseHandOff(raw, ticket, loop);
    if (typeof parsed === "string") {
      deps.log(`block-park: #${ticket} not parked, the hand-off file is refused: ${parsed}`);
      pushHigh("park-refused", `blocked: #${ticket} could not be parked, the hand-off file is refused: ${parsed}`);
      return;
    }
    try {
      const hours = budgetHours((deps.env ?? process.env).RALPH_PARK_BUDGET_HOURS);
      await withStore(deps.storePath, (store) => park(store, parsed, since(), hours));
    } catch (error) {
      const why = message(error);
      deps.log(`block-park: #${ticket} could not be parked: ${why}`);
      pushHigh("park-failed", `${parsed.summary}\n\nthe park could not be recorded: ${why}`);
    }
  } catch (error) {
    // A logger or clock that throws: still never out of here.
    try { deps.log(`block-park: #${ticket}: ${message(error)}`); } catch {
      // the logger itself failed: nothing is left to report to, and the label swap stands
    }
  } finally {
    remove(deps.file);
  }
}
