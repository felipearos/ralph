#!/usr/bin/env bun
/**
 * A host-wide quiet window, for the one thing a loop cannot do while its
 * siblings keep the CI box busy: run a heavy local command that an acceptance
 * criterion needs and that CI does not produce.
 *
 * Why it exists: loggd #1604 / PR #1809 (2026-09-29). AC5 asked for a
 * before/after bundle measurement from two production builds. The project's
 * host fence forbids local builds while CI is running on the host, and says to
 * "let CI provide that validation" instead — but CI does not produce that
 * number. The loops themselves keep the host busy: testo found it busy at all
 * seven checks between 08:47 and 10:36, parked the PR as a draft, and no loop
 * touches a stamped draft again. Only the supervisors can make the host go
 * quiet, because only they decide when the loops start their next turns.
 *
 * The flow:
 *
 *   1. The session writes `.ralph/logs/host-lease-request.json` (the ticket,
 *      the command, the acceptance criterion that needs it, why CI cannot
 *      produce it, and what the fence showed) and ends
 *      `<ralph>AWAIT_HOST <n></ralph>`.
 *   2. `acquire` validates the request against a policy (below), queues it
 *      FIFO, and waits with no model. At the head of the queue it becomes the
 *      holder and DRAINS: every other supervisor of this project is held
 *      before its next model turn (`turn-begin`), and the holder waits until
 *      none is inside one and no required check is pending on any open PR or
 *      on the base branch, twice running. Then it is GRANTED for a fixed time.
 *   3. `ralph.sh` resumes the same session with the answer (`prompt`), and
 *      `release`s the lease when that turn ends, whatever it ended with.
 *
 * NOT A RESOURCE LOOPS MAY REACH FOR. Holding every other loop still costs the
 * whole fleet its throughput, so the policy is deliberately narrow and every
 * limit is enforced here, not left to the prompt:
 *
 *   - a request names the ticket this loop has claimed, and every field is
 *     filled in; anything else is refused;
 *   - one request per iteration (enforced by `ralph.sh`), one queued request
 *     per run, and a short queue — past it, requests are refused, not piled up;
 *   - a ticket gets RALPH_HOST_LEASE_PER_TICKET grants and
 *     RALPH_HOST_LEASE_ASKS_PER_TICKET asks, ever — a refusal is an ask, so
 *     a loop cannot keep knocking one iteration after another;
 *   - a loop gets one grant per RALPH_HOST_LEASE_LOOP_COOLDOWN_SECONDS;
 *   - the host gets a gap of RALPH_HOST_LEASE_SPACING_SECONDS between one
 *     lease ending and the next starting, so leases cannot run back to back;
 *   - FIFO order: the first request queued is the first served. Nobody races
 *     for it by retrying, because a refused request is not a queue place.
 *
 * Every wait is bounded (queue, drain, grant), and a holder whose supervisor
 * died is cleared on the next read, so a crash never wedges the other loops.
 *
 * The store lives in Git's common directory, beside the claim leases: every
 * worktree of the project, hence every loop on it, sees the same file.
 *
 *   host-lease.ts acquire --ticket N [--claimed N] [--request F]   wait; one JSON result on stdout
 *   host-lease.ts prompt --result F                                the resumed session's message
 *   host-lease.ts release                                          end this run's lease/queue place
 *   host-lease.ts turn-begin | turn-end                            around every model turn
 *   host-lease.ts status [--json]
 *
 * `acquire` always exits 0 with a result; 64 is a usage error. `turn-begin`
 * never fails a turn: a store it cannot read lets the turn through. It exits 3
 * with `HELD_CONTROL_LINE` when, held behind a holder, it finds an operator
 * command in the inbox — the supervisor applies it and asks again.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import { hasPendingCommand } from "./control-inbox";
import { parseCheck } from "./pr-wait";

export const HOST_LEASE_VERSION = 1 as const;

/** `turn-begin`'s line and exit code when it stops waiting because an operator command is in the inbox. */
export const HELD_CONTROL_LINE = "host-lease: control command waiting — handing back to the supervisor";
export const HELD_CONTROL_EXIT = 3;

/**
 * The supervisor's control poll interval (`RALPH_CONTROL_POLL_SECONDS`), the
 * slice every wait looks at the inbox on; 15 s by default, as
 * `frontier-gate.ts` reads it. Parsed again here rather than imported from
 * there: this file runs around every model turn, and importing the gate would
 * drag the whole frontier graph in for three lines.
 *
 * `turn-begin` caps it at 15 s where the other waits honour it as configured,
 * because this one slice is also how often the hold re-locks the shared lease
 * store. A host that raised the interval would get a coarser hand-back than it
 * has today, and an absurd value would park the loop past the hold itself.
 */
function controlSliceSeconds(raw: string | undefined): number {
  return raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : 15;
}

export const REQUEST_RELATIVE_PATH = ".ralph/logs/host-lease-request.json";

/* --------------------------------------------------------------------------
 * The store.
 * ----------------------------------------------------------------------- */

export interface Party {
  run: string;
  loop: string;
  pid: number;
  host: string;
}

export interface Waiter extends Party {
  ticket: number;
  command: string;
  queuedAt: string;
}

export interface Holder extends Waiter {
  state: "draining" | "granted";
  since: string;
  drainDeadline: string;
  expiresAt: string | null;
}

export interface Turn {
  loop: string;
  pid: number;
  host: string;
  since: string;
}

export interface HostLeaseStore {
  version: 1;
  holder: Holder | null;
  queue: Waiter[];
  /** Supervisors inside a model turn, by run id. */
  turns: Record<string, Turn>;
  /** Grants and asks per ticket, ever. A refused ask counts too. */
  tickets: Record<string, { grants: number; lastGrantAt: string | null; asks?: number }>;
  /** The last grant per loop, for the cooldown. */
  loops: Record<string, { lastGrantAt: string }>;
  lastReleasedAt: string | null;
}

export const emptyStore = (): HostLeaseStore => ({
  version: 1, holder: null, queue: [], turns: {}, tickets: {}, loops: {}, lastReleasedAt: null,
});

export interface Policy {
  grantSeconds: number;
  drainSeconds: number;
  queueSeconds: number;
  perTicket: number;
  asksPerTicket: number;
  loopCooldownSeconds: number;
  spacingSeconds: number;
  queueMax: number;
  pollSeconds: number;
  /** Consecutive idle reads before a grant. */
  idleReads: number;
}

const KNOBS: Array<[keyof Policy, string, number]> = [
  ["grantSeconds", "RALPH_HOST_LEASE_SECONDS", 3600],
  ["drainSeconds", "RALPH_HOST_LEASE_DRAIN_SECONDS", 5400],
  ["queueSeconds", "RALPH_HOST_LEASE_QUEUE_SECONDS", 10800],
  ["perTicket", "RALPH_HOST_LEASE_PER_TICKET", 2],
  ["asksPerTicket", "RALPH_HOST_LEASE_ASKS_PER_TICKET", 3],
  ["loopCooldownSeconds", "RALPH_HOST_LEASE_LOOP_COOLDOWN_SECONDS", 21600],
  ["spacingSeconds", "RALPH_HOST_LEASE_SPACING_SECONDS", 1800],
  ["queueMax", "RALPH_HOST_LEASE_QUEUE_MAX", 2],
  ["pollSeconds", "RALPH_HOST_LEASE_POLL_SECONDS", 60],
  ["idleReads", "RALPH_HOST_LEASE_IDLE_READS", 2],
];

export function parsePolicy(env: Record<string, string | undefined>): Policy {
  const policy = {} as Policy;
  for (const [key, name, fallback] of KNOBS) {
    const raw = env[name]?.trim();
    const value = raw ? Number(raw) : fallback;
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative whole number; got '${raw}'`);
    policy[key] = value;
  }
  // A zero here would switch a limit off rather than tighten it.
  for (const key of ["perTicket", "asksPerTicket", "queueMax", "pollSeconds", "idleReads", "grantSeconds", "drainSeconds", "queueSeconds"] as const) {
    if (policy[key] === 0) throw new Error(`${KNOBS.find(([k]) => k === key)![1]} must be positive`);
  }
  return policy;
}

/* --------------------------------------------------------------------------
 * The request a session writes.
 * ----------------------------------------------------------------------- */

export interface LeaseRequest {
  ticket: number;
  /** The heavy command(s) the grant is for, and nothing else. */
  command: string;
  /** The acceptance criterion that needs the command's output. */
  criterion: string;
  /** Why no CI job produces that output. */
  whyNotCi: string;
  /** What the project's host fence showed when it refused the command. */
  fenceEvidence: string;
}

const MIN_FIELD = 15;

export function parseRequest(raw: string): LeaseRequest | string {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return "the request is not JSON"; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "the request is not a JSON object";
  const r = value as Record<string, unknown>;
  if (!Number.isInteger(r.ticket) || (r.ticket as number) <= 0) return "the request has no ticket number";
  for (const field of ["command", "criterion", "whyNotCi", "fenceEvidence"] as const) {
    if (typeof r[field] !== "string" || (r[field] as string).trim().length < MIN_FIELD) {
      return `the request's \`${field}\` is missing or too short to say anything`;
    }
  }
  return {
    ticket: r.ticket as number,
    command: (r.command as string).trim(),
    criterion: (r.criterion as string).trim(),
    whyNotCi: (r.whyNotCi as string).trim(),
    fenceEvidence: (r.fenceEvidence as string).trim(),
  };
}

/* --------------------------------------------------------------------------
 * The policy, pure. `now` is epoch ms; `alive` says whether a party still runs.
 * ----------------------------------------------------------------------- */

const iso = (ms: number): string => new Date(ms).toISOString();
const since = (at: string | null | undefined, now: number): number => (at ? (now - Date.parse(at)) / 1000 : Infinity);

/**
 * Has this holder run out of time? `granted` past `expiresAt`, or `draining`
 * more than five minutes past its drain deadline.
 *
 * Exported because `prune` is not the only thing that needs it: `prune` runs on
 * acquire and release alone, so a READER of the store — `ci-doctor/gate.ts`
 * asking whether the host is busy before a retry — would otherwise take a
 * leaked holder as live for ever, on exactly the quiet host that has no lease
 * traffic to prune it. One predicate, so the reader and the sweeper cannot
 * disagree about what a live lease is.
 */
export function holderLapsed(holder: Holder, now: number): boolean {
  if (holder.state === "granted") return holder.expiresAt !== null && Date.parse(holder.expiresAt) <= now;
  // `draining` by elimination on the type — but `readStore` validates only the
  // version, so a hand-edited store can carry any string here. An unknown
  // state is NOT treated as lapsed: clearing a holder this file does not
  // understand is the one direction that could hand the host to two loops.
  if (holder.state !== "draining") return false;
  return Date.parse(holder.drainDeadline) + 5 * 60_000 <= now;
}

/**
 * Clear what nobody is behind any more: turns and queue places of supervisors
 * that are gone, and a holder that is gone or whose grant ran out. A holder's
 * drain deadline is its own process's to act on; a dead holder is cleared here.
 * Returns what was cleared, for the log.
 */
export function prune(store: HostLeaseStore, now: number, alive: (party: { pid: number; host: string }) => boolean): string[] {
  const cleared: string[] = [];
  for (const [run, turn] of Object.entries(store.turns)) {
    if (!alive(turn)) { delete store.turns[run]; cleared.push(`turn of ${turn.loop} (${run})`); }
  }
  const before = store.queue.length;
  store.queue = store.queue.filter((waiter) => alive(waiter));
  if (store.queue.length !== before) cleared.push(`${before - store.queue.length} queued request(s) of a stopped supervisor`);
  const holder = store.holder;
  if (holder) {
    if (!alive(holder) || holderLapsed(holder, now)) {
      store.holder = null;
      store.lastReleasedAt = iso(now);
      cleared.push(`${holder.state} lease of ${holder.loop} for #${holder.ticket} (${!alive(holder) ? "supervisor gone" : "past its deadline"})`);
    }
  }
  return cleared;
}

export type Admission = { ok: true } | { ok: false; why: string };

/** May this request join the queue? Every refusal says which limit it hit. */
export function admit(
  store: HostLeaseStore,
  party: Party,
  request: LeaseRequest,
  claimed: number | null,
  policy: Policy,
  now: number,
): Admission {
  if (claimed === null) return { ok: false, why: "this loop holds no claimed ticket; a host lease is only for the ticket being worked" };
  if (request.ticket !== claimed) return { ok: false, why: `the request names #${request.ticket}, but this loop's claimed ticket is #${claimed}` };
  if (store.holder?.run === party.run || store.queue.some((waiter) => waiter.run === party.run)) {
    return { ok: false, why: "this run already holds or is queued for the host lease" };
  }
  const key = String(request.ticket);
  const record = store.tickets[key] ?? { grants: 0, lastGrantAt: null };
  const asks = record.asks ?? 0;
  store.tickets[key] = { ...record, asks: asks + 1 };
  if (asks >= policy.asksPerTicket) {
    return { ok: false, why: `#${request.ticket} has asked for the host ${asks} time(s), the most a ticket may (RALPH_HOST_LEASE_ASKS_PER_TICKET=${policy.asksPerTicket})` };
  }
  const grants = record.grants;
  if (grants >= policy.perTicket) {
    return { ok: false, why: `#${request.ticket} has had ${grants} host lease(s), the most a ticket gets (RALPH_HOST_LEASE_PER_TICKET=${policy.perTicket})` };
  }
  const last = store.loops[party.loop]?.lastGrantAt;
  if (since(last, now) < policy.loopCooldownSeconds) {
    return { ok: false, why: `${party.loop} had a host lease at ${last}; one per ${policy.loopCooldownSeconds}s (RALPH_HOST_LEASE_LOOP_COOLDOWN_SECONDS)` };
  }
  if (store.queue.length >= policy.queueMax) {
    return { ok: false, why: `${store.queue.length} request(s) already wait for the host (RALPH_HOST_LEASE_QUEUE_MAX=${policy.queueMax})` };
  }
  store.queue.push({ ...party, ticket: request.ticket, command: request.command, queuedAt: iso(now) });
  return { ok: true };
}

/**
 * Promote the head of the queue to a draining holder, if it is `run` and the
 * host is free and past its spacing. Returns true when `run` now holds it.
 */
export function promote(store: HostLeaseStore, run: string, policy: Policy, now: number): boolean {
  if (store.holder !== null) return store.holder.run === run;
  const head = store.queue[0];
  if (head?.run !== run) return false;
  if (since(store.lastReleasedAt, now) < policy.spacingSeconds) return false;
  store.queue.shift();
  store.holder = {
    ...head, state: "draining", since: iso(now),
    drainDeadline: iso(now + policy.drainSeconds * 1000), expiresAt: null,
  };
  return true;
}

/** Other supervisors still inside a model turn. */
export function othersInTurn(store: HostLeaseStore, run: string): Turn[] {
  return Object.entries(store.turns).filter(([other]) => other !== run).map(([, turn]) => turn);
}

/** Turn the draining holder `run` into a grant. */
export function grant(store: HostLeaseStore, run: string, policy: Policy, now: number): Holder | null {
  const holder = store.holder;
  if (holder?.run !== run || holder.state !== "draining") return null;
  holder.state = "granted";
  holder.expiresAt = iso(now + policy.grantSeconds * 1000);
  const key = String(holder.ticket);
  store.tickets[key] = { ...store.tickets[key], grants: (store.tickets[key]?.grants ?? 0) + 1, lastGrantAt: iso(now) };
  store.loops[holder.loop] = { lastGrantAt: iso(now) };
  return holder;
}

/** Give up whatever `run` holds or waits for. Returns true when it held the lease. */
export function releaseRun(store: HostLeaseStore, run: string, now: number): boolean {
  store.queue = store.queue.filter((waiter) => waiter.run !== run);
  if (store.holder?.run !== run) return false;
  store.holder = null;
  store.lastReleasedAt = iso(now);
  return true;
}

/** Is `run` held back from starting a model turn? */
export const heldBack = (store: HostLeaseStore, run: string): Holder | null =>
  store.holder !== null && store.holder.run !== run ? store.holder : null;

/* --------------------------------------------------------------------------
 * The file and its lock.
 * ----------------------------------------------------------------------- */

export function storePathFromGit(cwd = process.cwd()): string {
  const out = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  const common = out.status === 0 ? out.stdout.trim() : "";
  return common ? join(common, "ralph-host-lease.json") : join(resolve(cwd), ".ralph-host-lease.json");
}

export function readStore(path: string): HostLeaseStore {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
  const value = JSON.parse(raw) as Partial<HostLeaseStore>;
  if (value.version !== 1) throw new Error(`unsupported host lease store: ${path}`);
  return { ...emptyStore(), ...value } as HostLeaseStore;
}

function writeStore(path: string, store: HostLeaseStore): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(temp, path);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Read-modify-write under an exclusive lock file. Every critical section is a
 * few milliseconds; a lock older than 30s belongs to a process that died
 * inside one, and is broken.
 */
export async function withStore<T>(path: string, critical: (store: HostLeaseStore) => T): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let fd: number | null = null;
    try { fd = openSync(lock, "wx"); } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock); } catch {}
      if (attempt > 200) throw new Error(`the host lease store is locked: ${lock}`);
      await sleep(50);
      continue;
    }
    try {
      const store = readStore(path);
      const result = critical(store);
      writeStore(path, store);
      return result;
    } finally {
      closeSync(fd);
      try { unlinkSync(lock); } catch {}
    }
  }
}

/* --------------------------------------------------------------------------
 * Liveness and identity.
 * ----------------------------------------------------------------------- */

const thisHost = (): string => process.env.HOSTNAME ?? hostname();

/** A party on another host is taken as alive: its pid means nothing here, and its deadlines still bound it. */
export function partyAlive(party: { pid: number; host: string }): boolean {
  if (party.host !== thisHost() && party.host !== hostname()) return true;
  try { process.kill(party.pid, 0); return true; } catch { return false; }
}

export function identity(env = process.env): Party {
  const run = env.RALPH_RUN_ID?.trim();
  const loop = env.RALPH_LOOP_NAME?.trim();
  const pid = Number(env.RALPH_SUPERVISOR_PID ?? process.ppid);
  if (!run || !loop) throw new Error("host-lease needs RALPH_RUN_ID and RALPH_LOOP_NAME");
  return { run, loop, pid: Number.isInteger(pid) && pid > 0 ? pid : process.ppid, host: thisHost() };
}

/* --------------------------------------------------------------------------
 * Is CI idle? Every required check on every open PR, and on the base branch.
 * ----------------------------------------------------------------------- */

export interface CiRead { busy: boolean; detail: string }

/**
 * `gh` calls one `readCi` costs: the open-pull-request list, the base branch's
 * check runs, and its statuses.
 *
 * Named because a caller on a budget has to reserve them before asking —
 * `ci-doctor/gate.ts` spends them on the doctor's own GitHub allowance — and a
 * number spelt at the call site would drift the moment this function grows a
 * fourth read.
 */
export const CI_READ_GH_CALLS = 3;

/**
 * The required check names `readCi` should be asked about, off the environment.
 *
 * Shared because `readCi`'s two callers had two copies and they disagreed by a
 * `.trim()`: `counts()` below matches a name EXACTLY, so an untrimmed name
 * matches no check, nothing is ever pending, and a busy host reads as idle —
 * which is the one answer that must never be wrong by accident.
 */
export function requiredChecksFrom(env: NodeJS.ProcessEnv): string[] {
  return (env.RALPH_REQUIRED_CHECKS ?? "")
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
}

type Gh = (args: string[]) => { ok: boolean; out: string };

const ghCli: Gh = (args) => {
  const out = spawnSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  return { ok: out.status === 0, out: out.stdout ?? "" };
};

/**
 * Only checks that have REPORTED count, unlike `pr-wait`'s view of one PR: a
 * PR with no CI run at all (an idle draft) is not load on the host. A read
 * that fails is busy — the conservative answer, and the drain deadline bounds it.
 */
export function readCi(repo: string, base: string, required: readonly string[], gh: Gh = ghCli): CiRead {
  const counts = (name: string): boolean => required.length === 0 || required.includes(name);
  const pending: string[] = [];
  const prs = gh(["pr", "list", "--repo", repo, "--state", "open", "--limit", "200", "--json", "number,statusCheckRollup"]);
  if (!prs.ok) return { busy: true, detail: "could not list open pull requests" };
  let list: Array<{ number: number; statusCheckRollup?: unknown[] }>;
  try { list = JSON.parse(prs.out); } catch { return { busy: true, detail: "unreadable pull request list" }; }
  for (const pr of list) {
    for (const raw of pr.statusCheckRollup ?? []) {
      const check = parseCheck(raw);
      if (check && check.state === "pending" && counts(check.name)) pending.push(`#${pr.number} ${check.name}`);
    }
  }
  const runs = gh(["api", `repos/${repo}/commits/${base}/check-runs?per_page=100`]);
  const statuses = gh(["api", `repos/${repo}/commits/${base}/status`]);
  if (!runs.ok || !statuses.ok) return { busy: true, detail: `could not read ${base}'s checks` };
  try {
    for (const run of (JSON.parse(runs.out).check_runs ?? []) as Array<{ name: string; status: string }>) {
      if (run.status !== "completed" && counts(run.name)) pending.push(`${base} ${run.name}`);
    }
    for (const status of (JSON.parse(statuses.out).statuses ?? []) as Array<{ context: string; state: string }>) {
      if (status.state === "pending" && counts(status.context)) pending.push(`${base} ${status.context}`);
    }
  } catch { return { busy: true, detail: `unreadable checks on ${base}` }; }
  return pending.length > 0
    ? { busy: true, detail: `pending: ${pending.slice(0, 6).join(", ")}${pending.length > 6 ? ` and ${pending.length - 6} more` : ""}` }
    : { busy: false, detail: "no required check pending on any open PR or on " + base };
}

/**
 * Is anybody really using the host lease? The question a reader asks, as
 * against `prune`, which asks it in order to clear.
 *
 * Only a LIVE holder and LIVE waiters count. `prune` runs on acquire and
 * release alone, so on a host with no lease traffic a leaked holder would
 * otherwise read as in-use for ever — and the one caller
 * (`ci-doctor/gate.ts`'s retry) exists precisely for the quiet host.
 */
export function leaseInUse(
  store: HostLeaseStore,
  now: number,
  alive: (party: { pid: number; host: string }) => boolean = partyAlive,
): CiRead {
  const holder = store.holder;
  if (holder !== null && alive(holder) && !holderLapsed(holder, now)) {
    return { busy: true, detail: `host lease held by ${holder.loop} for #${holder.ticket}` };
  }
  const waiting = store.queue.filter((waiter) => alive(waiter));
  return waiting.length > 0
    ? { busy: true, detail: `${waiting.length} waiting for the host lease` }
    : { busy: false, detail: "no live host-lease holder and nobody queued" };
}

/* --------------------------------------------------------------------------
 * acquire: the supervisor's wait.
 * ----------------------------------------------------------------------- */

export type AcquireOutcome = "granted" | "refused" | "queue-timeout" | "drain-timeout" | "unreadable";

export interface AcquireResult {
  outcome: AcquireOutcome;
  ticket: number | null;
  command: string | null;
  expiresAt: string | null;
  detail: string;
}

export interface AcquireDeps {
  path: string;
  party: Party;
  policy: Policy;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  alive: (party: { pid: number; host: string }) => boolean;
  ci: () => CiRead;
  log: (line: string) => void;
}

export async function acquire(request: LeaseRequest | string, claimed: number | null, deps: AcquireDeps): Promise<AcquireResult> {
  const { path, party, policy, log } = deps;
  const result = (outcome: AcquireOutcome, detail: string, expiresAt: string | null = null): AcquireResult => ({
    outcome, detail, expiresAt,
    ticket: typeof request === "string" ? null : request.ticket,
    command: typeof request === "string" ? null : request.command,
  });
  if (typeof request === "string") return result("refused", request);

  const admission = await withStore(path, (store) => {
    prune(store, deps.now(), deps.alive).forEach((line) => log(`cleared ${line}`));
    return admit(store, party, request, claimed, policy, deps.now());
  });
  if (!admission.ok) return result("refused", admission.why);
  log(`queued for the host: #${request.ticket} — ${request.command}`);

  const queuedAt = deps.now();
  let drainingSince: number | null = null;
  let idleStreak = 0;
  try {
    for (;;) {
      const now = deps.now();
      const view = await withStore(path, (store) => {
        prune(store, now, deps.alive).forEach((line) => log(`cleared ${line}`));
        const holds = promote(store, party.run, policy, now);
        return { holds, holder: store.holder, others: othersInTurn(store, party.run), place: store.queue.findIndex((w) => w.run === party.run) };
      });
      if (!view.holds) {
        if (view.place < 0) return result("refused", "this request left the queue (released by its own supervisor, or cleared as stale)");
        if ((now - queuedAt) / 1000 >= policy.queueSeconds) {
          await withStore(path, (store) => releaseRun(store, party.run, deps.now()));
          return result("queue-timeout", `waited ${policy.queueSeconds}s in the queue behind ${view.holder ? `${view.holder.loop} (#${view.holder.ticket})` : "the spacing between leases"}`);
        }
        log(`place ${view.place + 1} in the queue${view.holder ? `; ${view.holder.loop} holds the host for #${view.holder.ticket}` : "; the host is spacing leases"}`);
        await deps.sleep(policy.pollSeconds * 1000);
        continue;
      }
      drainingSince ??= now;
      if ((now - drainingSince) / 1000 >= policy.drainSeconds) {
        await withStore(path, (store) => releaseRun(store, party.run, deps.now()));
        return result("drain-timeout", `the host did not go quiet within ${policy.drainSeconds}s; the other loops were released`);
      }
      if (view.others.length > 0) {
        idleStreak = 0;
        log(`draining: ${view.others.map((turn) => turn.loop).join(", ")} still inside a turn; they start no new one`);
        await deps.sleep(policy.pollSeconds * 1000);
        continue;
      }
      const ci = deps.ci();
      idleStreak = ci.busy ? 0 : idleStreak + 1;
      if (idleStreak < policy.idleReads) {
        log(`draining: ${ci.detail} (idle ${idleStreak}/${policy.idleReads})`);
        await deps.sleep(policy.pollSeconds * 1000);
        continue;
      }
      const holder = await withStore(path, (store) => grant(store, party.run, policy, deps.now()));
      if (holder === null) return result("refused", "the lease was cleared while it drained");
      log(`granted until ${holder.expiresAt}`);
      return result("granted", `other loops are held before their next turn and ${ci.detail}`, holder.expiresAt);
    }
  } catch (error) {
    try { await withStore(path, (store) => releaseRun(store, party.run, deps.now())); } catch {}
    return result("unreadable", error instanceof Error ? error.message : String(error));
  }
}

/* --------------------------------------------------------------------------
 * The resumed session's message.
 * ----------------------------------------------------------------------- */

export function resumePrompt(result: AcquireResult): string {
  if (result.outcome === "granted") {
    return [
      `Host lease GRANTED for #${result.ticket} until ${result.expiresAt}. The supervisor resumed this same session.`,
      `Every other loop on this project is held before its next model turn, and ${result.detail}.`,
      `Check the project's host fence once more. If it is clear, run only what your request named — ${result.command} — and nothing else heavy, then record the result where the ticket needs it and continue the work.`,
      "If the fence still shows CI work, do not run it: something outside the loops is using the host. Take the blocked path in §6 and say so.",
      "The lease is released when this turn ends, whatever it ends with. Do not end with AWAIT_HOST again in this iteration: it will be refused.",
      "End with one of the endings in §6, per the HARD RAIL.",
    ].join("\n\n");
  }
  return [
    `Host lease NOT granted (${result.outcome}): ${result.detail}. The supervisor resumed this same session.`,
    "Do not run the fenced command, and do not end with AWAIT_HOST again in this iteration: it will be refused.",
    result.outcome === "refused"
      ? "Take the blocked path in §6. Quote this refusal in the stuck comment, so a human can see which limit was hit."
      : "Take the blocked path in §6, and say in the stuck comment that the host never went quiet long enough.",
    "End with one of the endings in §6, per the HARD RAIL.",
  ].join("\n\n");
}

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

const flag = (argv: string[], name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

const USAGE =
  "usage: host-lease.ts acquire --ticket N [--claimed N] [--request F] | prompt --result F | release | turn-begin | turn-end | status [--json]";

export async function main(argv: string[], env = process.env): Promise<number> {
  const [command, ...rest] = argv;
  const path = storePathFromGit(env.RALPH_STATE_ROOT ?? process.cwd());
  const log = (line: string): void => { console.error(`host-lease: ${line}`); };

  if (command === "status") {
    const store = readStore(path);
    if (rest.includes("--json")) { console.log(JSON.stringify({ path, ...store }, null, 2)); return 0; }
    const holder = store.holder;
    console.log(holder
      ? `${holder.state} by ${holder.loop} for #${holder.ticket}${holder.expiresAt ? ` until ${holder.expiresAt}` : ` (drain deadline ${holder.drainDeadline})`}`
      : "no host lease held");
    for (const waiter of store.queue) console.log(`queued: ${waiter.loop} for #${waiter.ticket} since ${waiter.queuedAt}`);
    return 0;
  }

  if (command === "prompt") {
    const file = flag(rest, "result");
    if (!file) { console.error(USAGE); return 64; }
    let result: AcquireResult;
    try { result = JSON.parse(readFileSync(file, "utf8")) as AcquireResult; }
    catch { result = { outcome: "unreadable", ticket: null, command: null, expiresAt: null, detail: "the supervisor's wait produced no result" }; }
    process.stdout.write(resumePrompt(result));
    return 0;
  }

  const party = identity(env);

  if (command === "acquire") {
    const ticket = Number(flag(rest, "ticket"));
    if (!Number.isInteger(ticket) || ticket <= 0) { console.error(USAGE); return 64; }
    const claimedRaw = Number(flag(rest, "claimed"));
    const claimed = Number.isInteger(claimedRaw) && claimedRaw > 0 ? claimedRaw : null;
    const policy = parsePolicy(env);
    let request: LeaseRequest | string;
    try {
      request = parseRequest(readFileSync(flag(rest, "request") ?? REQUEST_RELATIVE_PATH, "utf8"));
    } catch {
      request = `no request file at ${flag(rest, "request") ?? REQUEST_RELATIVE_PATH}`;
    }
    if (typeof request !== "string" && request.ticket !== ticket) {
      request = `the sigil names #${ticket} but the request names #${request.ticket}`;
    }
    const repo = env.RALPH_PROJECT_REPO?.trim() ?? "";
    const base = env.RALPH_BASE_BRANCH?.trim() || "main";
    const required = requiredChecksFrom(env);
    const result = await acquire(request, claimed, {
      path, party, policy, log,
      now: Date.now, sleep, alive: partyAlive,
      ci: () => (repo ? readCi(repo, base, required) : { busy: true, detail: "RALPH_PROJECT_REPO is not set" }),
    });
    console.log(JSON.stringify(result));
    return 0;
  }

  if (command === "release") {
    const held = await withStore(path, (store) => releaseRun(store, party.run, Date.now()));
    if (held) log(`released by ${party.loop}`);
    return 0;
  }

  if (command === "turn-begin") {
    // Held back while another run holds the host, then registered in the same
    // critical section, so a holder can never miss a turn that slipped past.
    // The hold can last hours (a drain plus a grant), so like every other
    // supervisor wait it looks at the control inbox between slices and hands
    // an operator command back to the checkpoint rather than sleeping on it.
    const root = env.RALPH_PROJECT ?? process.cwd();
    const slice = Math.min(15, controlSliceSeconds(env.RALPH_CONTROL_POLL_SECONDS));
    let said = false;
    for (;;) {
      const holder = await withStore(path, (store) => {
        prune(store, Date.now(), partyAlive);
        const blocking = heldBack(store, party.run);
        if (blocking === null) store.turns[party.run] = { loop: party.loop, pid: party.pid, host: party.host, since: iso(Date.now()) };
        return blocking;
      });
      if (holder === null) return 0;
      if (!said) {
        console.log(`${party.loop}: held before its next turn — ${holder.loop} has the host for #${holder.ticket} (${holder.state}); no model runs meanwhile.`);
        said = true;
      }
      await sleep(slice * 1000);
      // Only while held: a turn that is not held registered and returned above,
      // and the checkpoint right before it already answered the inbox, so a
      // turn must never be refused for what is sitting there.
      if (hasPendingCommand(root)) {
        console.log(HELD_CONTROL_LINE);
        return HELD_CONTROL_EXIT;
      }
    }
  }

  if (command === "turn-end") {
    await withStore(path, (store) => { delete store.turns[party.run]; });
    return 0;
  }

  console.error(USAGE);
  return 64;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      console.error(`host-lease: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
