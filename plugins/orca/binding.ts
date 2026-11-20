import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { writeJsonAtomically } from "../../loop-state";
import type { Called } from "./cli";

export interface AdapterBindingIdentity {
  ralphRun: string;
  orcaRun: string | null;
  worktree: string;
}

export interface LiveBindingIdentity {
  ralphRun: string;
  worktree: string;
}

export const ORCA_BINDING_RELATIVE_PATH = ".ralph/logs/orca-consumer-binding.json";
export const BINDING_VERBS = ["orchestration run-current", "orchestration run-use"] as const;
export const DEFAULT_OBSERVER_BIND_INTERVAL_MS = 60_000;

export interface OrcaConsumerBinding {
  version: 1;
  ralphRun: string;
  orcaRun: string;
  worktree: string;
  consumer: string;
  boundAt: string;
}

export type BindingCall = (
  verb: "orchestration run-current" | "orchestration run-use",
  args: string[],
) => Called;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

export function readAdapterBindingIdentity(root: string): AdapterBindingIdentity | null {
  const path = join(root, ".ralph/logs/orca-lifecycle.json");
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const ralphRun = text(row.ralphRun);
  const worktree = text(row.worktree);
  const orcaRun = text(row.orcaRun);
  return row.version === 1 && ralphRun && worktree
    ? { ralphRun, worktree, orcaRun }
    : null;
}

export function observerBindingKey(
  root: string,
  liveRalphRun: string | null,
  observer: string | null,
): string | null {
  const adapter = readAdapterBindingIdentity(root);
  return adapter?.orcaRun != null &&
    liveRalphRun === adapter.ralphRun &&
    observer != null &&
    observer.trim() !== "" &&
    resolve(adapter.worktree) === resolve(root)
    ? [adapter.ralphRun, adapter.orcaRun, resolve(root), observer].join("\0")
    : null;
}

export function shouldAttemptObserverBinding(
  key: string | null,
  previousKey: string | null,
  previousAttemptAt: number,
  nowMs: number,
  intervalMs = DEFAULT_OBSERVER_BIND_INTERVAL_MS,
): boolean {
  return key !== null && (key !== previousKey || nowMs - previousAttemptAt >= intervalMs);
}

export function parseOrcaConsumerBinding(raw: string): OrcaConsumerBinding | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1) return null;
  const ralphRun = text(row.ralphRun);
  const orcaRun = text(row.orcaRun);
  const worktree = text(row.worktree);
  const consumer = text(row.consumer);
  const boundAt = text(row.boundAt);
  return ralphRun && orcaRun && worktree && consumer && boundAt
    ? { version: 1, ralphRun, orcaRun, worktree, consumer, boundAt }
    : null;
}

export function readOrcaConsumerBinding(root: string): OrcaConsumerBinding | null {
  const path = join(root, ORCA_BINDING_RELATIVE_PATH);
  return existsSync(path) ? parseOrcaConsumerBinding(readFileSync(path, "utf8")) : null;
}

const readInvalidatedConsumer = (root: string): string | null => {
  const path = join(root, ORCA_BINDING_RELATIVE_PATH);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof value !== "object" || value === null) return null;
    return text((value as Record<string, unknown>).invalidatedConsumer);
  } catch {
    return null;
  }
};

const runId = (called: Called): string | null => {
  const run = called.result?.run;
  return typeof run === "object" && run !== null ? text((run as Record<string, unknown>).id) : null;
};

/**
 * Return the consumer known to own this exact loop Run, never a binding left
 * by a replaced supervisor or by another worktree.
 */
export function resolveOrcaConsumer(
  root: string,
  adapter: AdapterBindingIdentity | null,
  live: LiveBindingIdentity,
  fallback: string | null,
): string | null {
  if (
    adapter?.orcaRun == null ||
    adapter.ralphRun !== live.ralphRun ||
    resolve(adapter.worktree) !== resolve(root) ||
    resolve(live.worktree) !== resolve(root)
  ) return fallback;
  const binding = readOrcaConsumerBinding(root);
  if (binding === null && readInvalidatedConsumer(root) === fallback) return null;
  return binding !== null &&
    binding.ralphRun === adapter.ralphRun &&
    binding.orcaRun === adapter.orcaRun &&
    resolve(binding.worktree) === resolve(adapter.worktree)
    ? binding.consumer
    : fallback;
}

export type ReconcileBindingResult =
  | { status: "bound" | "already-bound"; binding: OrcaConsumerBinding }
  | { status: "skipped" | "refused" | "failed"; why: string };

/**
 * Bind an observer terminal to the live loop Run.
 *
 * `run-current --from` is the authority. A terminal already bound elsewhere
 * is refused rather than than stolen; an unbound terminal is attached with
 * `run-use`. The record is written only after Orca confirms the ownership.
 */
export function reconcileOrcaConsumerBinding(
  root: string,
  adapter: AdapterBindingIdentity | null,
  liveRalphRun: string | null,
  observer: string | null,
  call: BindingCall,
): ReconcileBindingResult {
  if (adapter?.orcaRun == null) return { status: "skipped", why: "the loop has no Orca Run" };
  if (liveRalphRun === null || liveRalphRun !== adapter.ralphRun) {
    return { status: "skipped", why: "the lifecycle record belongs to a replaced Ralph run" };
  }
  if (resolve(adapter.worktree) !== resolve(root)) {
    return { status: "skipped", why: "the lifecycle record belongs to another worktree" };
  }
  if (observer === null || observer.trim() === "") {
    return { status: "skipped", why: "the observer has no Orca terminal handle" };
  }

  const current = call("orchestration run-current", ["--from", observer]);
  if (!current.ok) return { status: "failed", why: current.why };
  const boundRun = runId(current);
  if (boundRun !== null && boundRun !== adapter.orcaRun) {
    const recorded = readOrcaConsumerBinding(root);
    if (
      recorded !== null &&
      recorded.ralphRun === adapter.ralphRun &&
      recorded.orcaRun === adapter.orcaRun &&
      resolve(recorded.worktree) === resolve(root) &&
      recorded.consumer === observer
    ) {
      writeJsonAtomically(join(root, ORCA_BINDING_RELATIVE_PATH), {
        version: 1,
        invalidatedConsumer: observer,
        invalidatedAt: new Date().toISOString(),
        why: "consumer was reassigned to a different Orca Run",
      });
    }
    return {
      status: "refused",
      why: `observer ${observer} is already bound to foreign Run ${boundRun}`,
    };
  }
  if (boundRun === null) {
    const used = call("orchestration run-use", ["--id", adapter.orcaRun, "--from", observer]);
    if (!used.ok) return { status: "failed", why: used.why };
  }

  const binding: OrcaConsumerBinding = {
    version: 1,
    ralphRun: adapter.ralphRun,
    orcaRun: adapter.orcaRun,
    worktree: resolve(root),
    consumer: observer,
    boundAt: new Date().toISOString(),
  };
  writeJsonAtomically(join(root, ORCA_BINDING_RELATIVE_PATH), binding);
  return { status: boundRun === null ? "bound" : "already-bound", binding };
}
