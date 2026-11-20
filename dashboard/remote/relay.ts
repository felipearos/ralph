/**
 * The command relay: the bridge's side of a remote click (spec #165 §5, §7
 * "Kill switch").
 *
 * Each `ralph.command` row the Vercel app inserted becomes one `POST` on the
 * RUNNING local dashboard, so every refusal, confirmation, idempotency check
 * and record runs exactly as for a local click, and the local answer is
 * written back to the row for the app to return.
 *
 * - **Triggers.** A `command` wake-up names one row; every sweep (each
 *   (re)subscribe, and every 30 s) looks at all queued rows. A wake-up is a
 *   hint: the row is always read and claimed here, over Postgres.
 * - **Claim.** One conditional update is the at-most-once gate: only a
 *   `queued`, unexpired row, and only while this instance holds the lease.
 *   Rows run one at a time per loop (`body.loop`, or `body.name` for Add
 *   agent's start), oldest first, so one loop's commands run in the order
 *   they were issued.
 * - **Execute.** `RELAY_ROUTES` is the closed kind-to-route map: the row picks
 *   a kind, never a route, and its other body fields reach the local route as
 *   they are, where unknown ones are ignored. The body already carries the
 *   app's `id` (the idempotency key) and `via: "remote"` (History's "via
 *   remote").
 * - **Write back.** `http_status` and `result` verbatim (`result` is a `json`
 *   column, so the text keeps its bytes); 2xx is `done`, even when the
 *   recorded outcome is a refusal, and anything else is `refused`.
 * - **Restart's long wait.** Re-issued with the same id while it answers
 *   `halted` with `stop-pending` or `supervisor-running`, for up to 10 min,
 *   with each intermediate answer written to the still-`claimed` row.
 * - **TTL.** A row still `queued` past `expires_at` is `expired`, by the
 *   database's clock.
 * - **Crash reconciliation**, once per process when it first holds the lease:
 *   rows another instance claimed and never finished. `control`, `restart`
 *   and `mark-read` are re-issued with the same id, which the local routes
 *   answer as a replay. `stop-now`, `start`, `resume-work` and `agent-start`
 *   are never re-run: the row takes the outcome the loop's History recorded
 *   under its id, or `failed`.
 * - **Prune** finished rows older than 30 days, once a day.
 * - **Kill switch** (`RALPH_BRIDGE_CONTROLS=off`): every row is claimed and
 *   `refused` without reaching the machine. Otherwise a local dashboard that
 *   is down means nothing is claimed, so queued rows expire honestly.
 *
 * Like the rest of the bridge it imports no ralph module and no dashboard
 * adapter, and names no route but the History read (the map's are the route
 * table's), which `read-only.test.ts` pins.
 */
import type { HistoryView, RelayedCommandKind } from "../contracts";
import { RELAY_ROUTES } from "../route-table";
import type { BridgeStore, RelayHooks } from "./bridge";
import type { CommandWake } from "./wake";

/**
 * The closed kind-to-route map: the only local routes a command row can reach,
 * read off the route table's command rows (#629) so the relay and the hosted
 * function agree on what is relayed.
 */
export { RELAY_ROUTES };

/** The kinds a restarted bridge re-issues: the local route answers a replay by id. */
const REISSUED: readonly RelayedCommandKind[] = ["control", "restart", "mark-read"];

export const KILL_SWITCH_WHY = "remote control is disabled on the machine";
export const RESTARTED_WHY = "the bridge restarted mid-command; check the loop's History";

/** How long restart's re-issued wait may run in all, and the pause between re-issues. */
export const RESTART_WAIT_MS = 10 * 60_000;
export const RESTART_RETRY_MS = 5_000;
/** How often finished rows past 30 days are deleted. */
export const PRUNE_EVERY_MS = 24 * 60 * 60_000;

/** The restart halts that mean "re-issue with the same id to keep waiting" (`lifecycle.ts`). */
const STILL_WAITING = new Set(["stop-pending", "supervisor-running"]);

const LEASED = `exists (select 1 from ralph.bridge where instance = $1::text and lease_until > now())`;
/** The loop a row is for: what `body.loop` names, or Add agent's `body.name`. */
const LOOP = `coalesce(body ->> 'loop', body ->> 'name', '')`;
// `result` takes its text through `::text::json`: postgres.js serializes a
// parameter the server describes as `json` with JSON.stringify, which would
// store the answer as one JSON string instead of the answer itself.

/** Every statement the relay runs, as role `ralph_bridge`. Where a statement takes this instance, it is `$1`. */
export const RELAY_SQL = {
  /** Whether this instance holds the lease now. */
  leased: `select ${LEASED} as leased`,
  /** The at-most-once gate (spec §5 "Claim"). */
  claim: `
    update ralph.command set state = 'claimed', claimed_at = now(), claimed_by = $1::text, attempts = attempts + 1
    where id = $2::uuid and state = 'queued' and expires_at > now()
      and ${LEASED}
    returning id, project, kind, body`,
  /** One row, as a wake-up names it. */
  row: `select id, project, ${LOOP} as loop, state from ralph.command where id = $1::uuid`,
  /** The oldest claimable row of one loop. */
  oldest: `
    select id from ralph.command
    where project = $1::text and ${LOOP} = $2::text and state = 'queued' and expires_at > now()
    order by created_at, id limit 1`,
  /** Every loop with a claimable row, the loop whose row is oldest first. */
  pending: `
    select project, ${LOOP} as loop from ralph.command
    where state = 'queued' and expires_at > now()
    group by 1, 2 order by min(created_at)`,
  /** Queued rows past their TTL; the wording is the app's (`handler.ts`). */
  expire: `
    update ralph.command
    set state = 'expired', finished_at = now(),
        why = 'the machine did not pick it up within ' || case kind when 'control' then '5 min' when 'mark-read' then '10 min' when 'eval-start' then '5 min' when 'eval-set-add' then '5 min' when 'eval-set-check' then '5 min' when 'eval-inbox-add' then '5 min' when 'eval-inbox-start' then '5 min' when 'eval-improve-propose' then '5 min' when 'eval-proposal-open-pr' then '5 min' else '60 s' end
    where state = 'queued' and expires_at <= now() and ${LEASED}
    returning id`,
  /** An intermediate answer on a row still running (restart's wait). */
  progress: `
    update ralph.command set http_status = $3::int, result = $4::text::json
    where id = $2::uuid and state = 'claimed' and claimed_by = $1::text`,
  /** The row's end. Only the instance that claimed it may finish it. */
  finish: `
    update ralph.command set state = $3::text, http_status = $4::int, result = $5::text::json, why = $6::text, finished_at = now()
    where id = $2::uuid and state = 'claimed' and claimed_by = $1::text
    returning id`,
  /** Rows another instance claimed and never finished. */
  orphans: `
    select id, project, kind, body, claimed_by from ralph.command
    where state = 'claimed' and claimed_by <> $1::text and ${LEASED}
    order by created_at, id`,
  /** Take an orphan over, so exactly one instance reconciles it. */
  adopt: `
    update ralph.command set claimed_by = $1::text, claimed_at = now(), attempts = attempts + 1
    where id = $2::uuid and state = 'claimed' and claimed_by = $3::text and ${LEASED}
    returning id, project, kind, body`,
  /** Finished rows older than 30 days. */
  prune: `
    delete from ralph.command
    where state in ('done', 'refused', 'expired', 'failed')
      and coalesce(finished_at, created_at) < now() - interval '30 days' and ${LEASED}
    returning id`,
} as const;

export interface RelayOptions {
  store: BridgeStore;
  /** This bridge's instance id: the lease holder and every claim's `claimed_by`. */
  instance: string;
  /** The local dashboard, `http://127.0.0.1:<port>`. */
  base: string;
  /** In tests, the real handler behind a recording fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** `RALPH_BRIDGE_CONTROLS`: `off` is the kill switch. */
  controls?: "on" | "off";
  /** Whether the local dashboard answers; while it does not, nothing is claimed. */
  localUp?: () => boolean;
  /** Turn a project hot, so the next snapshot push shows what the command did. */
  markHot?: (project: string) => void;
  /** Wall time in ms, for restart's 10 minutes and the daily prune. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  restartWaitMs?: number;
  restartRetryMs?: number;
  log?: (line: string) => void;
}

export interface Relay extends Required<RelayHooks> {
  /** Resolves once no sweep and no loop's queue is running; for tests and a clean stop. */
  idle(): Promise<void>;
}

interface Row {
  id: string;
  project: string;
  kind: RelayedCommandKind;
  body: Record<string, unknown>;
}

type Ending = { state: "done" | "refused" | "failed"; status: number | null; result: string | null; why: string | null };

/** The loop a body is for, as `LOOP` reads it in SQL. */
const loopOf = (body: Record<string, unknown>): string =>
  typeof body.loop === "string" ? body.loop : typeof body.name === "string" ? body.name : "";

/** A local answer as the `json` column takes it: the text itself, or a JSON string of a non-JSON body. */
const asJson = (text: string): string => {
  try {
    JSON.parse(text);
    return text;
  } catch {
    return JSON.stringify(text);
  }
};

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createRelay(options: RelayOptions): Relay {
  const { store, instance } = options;
  const base = options.base.replace(/\/+$/, "");
  const fetchLocal = options.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const disabled = options.controls === "off";
  const localUp = options.localUp ?? (() => true);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const restartWaitMs = options.restartWaitMs ?? RESTART_WAIT_MS;
  const restartRetryMs = options.restartRetryMs ?? RESTART_RETRY_MS;
  const log = options.log ?? ((line: string) => console.error(`ralph-bridge: relay: ${line}`));

  /** A statement that takes this instance as `$1`. */
  const mine = <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> =>
    store.query<T>(text, [instance, ...params]);

  /** Per loop: its running queue, and whether it should look again before it ends. */
  const queues = new Map<string, { again: boolean; done: Promise<void> }>();
  /** Per loop: rows adopted from a previous instance, re-issued before anything new. */
  const adopted = new Map<string, Row[]>();
  let sweeping: Promise<void> | null = null;
  let reconciled = false;
  let prunedAt = Number.NEGATIVE_INFINITY;

  const queueKey = (project: string, loop: string): string => `${project}\u0000${loop}`;
  /** A route's project-scoped form: `/api/control` for `fixture` is `/api/p/fixture/control`. */
  const scoped = (project: string, route: string): string =>
    `${base}/api/p/${encodeURIComponent(project)}${route.slice("/api".length)}`;

  /** POST the row's body to its kind's fixed route, or say why the dashboard could not be reached. */
  const post = async (row: Row): Promise<{ status: number; text: string } | { unreachable: string }> => {
    try {
      const response = await fetchLocal(scoped(row.project, RELAY_ROUTES[row.kind]), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(row.body),
      });
      return { status: response.status, text: await response.text() };
    } catch (error) {
      return { unreachable: message(error) };
    }
  };

  const finish = async (row: Row, ending: Ending): Promise<void> => {
    const rows = await mine(RELAY_SQL.finish, [row.id, ending.state, ending.status, ending.result, ending.why]);
    if (rows.length === 0) log(`${row.kind} ${row.id} was no longer this bridge's to finish`);
  };

  /** Run one claimed row to its end and write the answer back. */
  const execute = async (row: Row): Promise<void> => {
    if (disabled) {
      await finish(row, { state: "refused", status: null, result: null, why: KILL_SWITCH_WHY });
      return;
    }
    options.markHot?.(row.project);
    const deadline = now() + restartWaitMs;
    for (;;) {
      const answer = await post(row);
      if ("unreachable" in answer) {
        await finish(row, { state: "failed", status: null, result: null, why: `the local dashboard could not be reached: ${answer.unreachable}` });
        return;
      }
      const ok = answer.status >= 200 && answer.status < 300;
      const result = asJson(answer.text);
      const halt = parsed(answer.text) as { outcome?: unknown; halt?: unknown } | null;
      const waiting = row.kind === "restart" && ok && halt?.outcome === "halted" && STILL_WAITING.has(String(halt.halt));
      if (waiting && now() < deadline) {
        // The page shows "waiting for the iteration boundary" from this.
        await mine(RELAY_SQL.progress, [row.id, answer.status, result]);
        await sleep(restartRetryMs);
        continue;
      }
      await finish(row, { state: ok ? "done" : "refused", status: answer.status, result, why: null });
      return;
    }
  };

  /** A row a previous instance started and may have finished: never run a second time. */
  const settleFromHistory = async (row: Row): Promise<void> => {
    let entry: HistoryView["entries"][number] | undefined;
    try {
      const response = await fetchLocal(scoped(row.project, `/api/loops/${encodeURIComponent(loopOf(row.body))}/history`), { method: "GET" });
      if (response.ok) entry = ((await response.json()) as HistoryView).entries.find((candidate) => candidate.id === row.id);
    } catch (error) {
      log(`could not read ${row.project} ${loopOf(row.body)}'s History for ${row.id}: ${message(error)}`);
    }
    if (entry === undefined || entry.outcome === "pending") {
      await finish(row, { state: "failed", status: null, result: null, why: RESTARTED_WHY });
      return;
    }
    await finish(row, {
      state: "done",
      status: null,
      result: JSON.stringify(entry),
      why: `the bridge restarted mid-command; the loop's History recorded it as ${entry.outcome}`,
    });
  };

  /** Claim and run one loop's rows, oldest first, until none is left. */
  const drain = async (project: string, loop: string): Promise<void> => {
    const key = queueKey(project, loop);
    for (let row = adopted.get(key)?.shift(); row !== undefined; row = adopted.get(key)?.shift()) {
      if (disabled) await finish(row, { state: "refused", status: null, result: null, why: KILL_SWITCH_WHY });
      else await execute(row);
    }
    adopted.delete(key);
    for (;;) {
      if (!disabled && !localUp()) return;
      const [next] = await store.query<{ id: string }>(RELAY_SQL.oldest, [project, loop]);
      if (next === undefined) return;
      const [row] = await mine<Row>(RELAY_SQL.claim, [next.id]);
      // Not ours to run: the lease is gone or the row expired under us. A later sweep looks again.
      if (row === undefined) return;
      await execute(row);
    }
  };

  /** Make sure `loop`'s queue runs; a running one looks again before it ends. */
  const kick = (project: string, loop: string): void => {
    const key = queueKey(project, loop);
    const running = queues.get(key);
    if (running !== undefined) {
      running.again = true;
      return;
    }
    const queue = { again: true, done: Promise.resolve() };
    queues.set(key, queue);
    queue.done = (async () => {
      try {
        while (queue.again) {
          queue.again = false;
          await drain(project, loop);
        }
      } catch (error) {
        log(`${project} ${loop}: ${message(error)}`);
      } finally {
        queues.delete(key);
      }
    })();
  };

  /** Rows a previous instance claimed: re-issue what is idempotent, settle the rest from History. */
  const reconcile = async (): Promise<void> => {
    const orphans = await mine<Row & { claimed_by: string }>(RELAY_SQL.orphans);
    for (const orphan of orphans) {
      const [row] = await mine<Row>(RELAY_SQL.adopt, [orphan.id, orphan.claimed_by]);
      if (row === undefined) continue;
      log(`reconciling ${row.kind} ${row.id}, claimed by ${orphan.claimed_by}`);
      if (REISSUED.includes(row.kind)) {
        const key = queueKey(row.project, loopOf(row.body));
        adopted.set(key, [...(adopted.get(key) ?? []), row]);
        kick(row.project, loopOf(row.body));
      } else {
        await settleFromHistory(row);
      }
    }
  };

  const sweep = async (): Promise<void> => {
    const [state] = await mine<{ leased: boolean }>(RELAY_SQL.leased);
    if (state?.leased !== true) return;
    const expired = await mine(RELAY_SQL.expire);
    if (expired.length > 0) log(`expired ${expired.length} command(s) nobody picked up in time`);
    if (now() - prunedAt >= PRUNE_EVERY_MS) {
      prunedAt = now();
      const pruned = await mine(RELAY_SQL.prune);
      if (pruned.length > 0) log(`pruned ${pruned.length} finished command(s) older than 30 days`);
    }
    if (!disabled && !localUp()) return;
    if (!reconciled && localUp()) {
      reconciled = true;
      await reconcile();
    }
    const pending = await store.query<{ project: string; loop: string }>(RELAY_SQL.pending, []);
    for (const { project, loop } of pending) kick(project, loop);
  };

  return {
    async onCommand(wake: CommandWake) {
      // A hint: the row itself says which loop it is for, and whether there is anything to do.
      const [row] = await store.query<{ project: string; loop: string; state: string }>(RELAY_SQL.row, [wake.id]);
      if (row === undefined || row.state !== "queued") return;
      if (!disabled && !localUp()) return;
      kick(row.project, row.loop);
    },
    async onSweep() {
      // One sweep at a time; a sweep asked for meanwhile is the running one.
      sweeping ??= sweep().finally(() => {
        sweeping = null;
      });
      await sweeping;
    },
    async idle() {
      while (sweeping !== null || queues.size > 0) {
        await Promise.allSettled([sweeping, ...[...queues.values()].map((queue) => queue.done)]);
      }
    },
  };
}
