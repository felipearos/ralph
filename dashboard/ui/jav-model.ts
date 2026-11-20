/**
 * The Jav page's edits, as pure functions over a copy of the config. They
 * never judge a candidate — `jav.ts --save` does — but they keep it
 * consistent: removing a label also drops it from every route, so the page
 * cannot build a route to a label that no longer exists.
 */
import type { JavConfigView } from "../contracts";

/** What a first switch-on offers, so the operator starts from the usual pair. */
export const SUGGESTED_LABELS = ["difficulty:easy", "difficulty:hard"];

export function setEnabled(config: JavConfigView, enabled: boolean): JavConfigView {
  const labels = enabled && config.labels.length === 0 ? [...SUGGESTED_LABELS] : config.labels;
  return { ...config, enabled, labels };
}

export function addLabel(config: JavConfigView, label: string): JavConfigView {
  const name = label.trim();
  if (name === "" || config.labels.includes(name)) return config;
  return { ...config, labels: [...config.labels, name] };
}

export function removeLabel(config: JavConfigView, label: string): JavConfigView {
  const routes = Object.fromEntries(
    Object.entries(config.routes).map(([loop, taken]) => [loop, taken.filter((name) => name !== label)]),
  );
  return { ...config, labels: config.labels.filter((name) => name !== label), routes };
}

/** Give or take one label from one loop. Labels stay in the order `labels` lists them. */
export function toggleRoute(config: JavConfigView, loop: string, label: string): JavConfigView {
  const taken = config.routes[loop] ?? [];
  const next = taken.includes(label) ? taken.filter((name) => name !== label) : [...taken, label];
  const ordered = config.labels.filter((name) => next.includes(name));
  const routes = { ...config.routes };
  if (ordered.length === 0) delete routes[loop];
  else routes[loop] = ordered;
  return { ...config, routes };
}

/** Why a label cannot be added, or null. A hint only; the save is the judge. */
export function labelHint(config: JavConfigView, reserved: readonly string[], label: string): string | null {
  const name = label.trim();
  if (name === "") return null;
  if (reserved.includes(name)) return `'${name}' is a label the loop already uses.`;
  if (config.labels.includes(name)) return `'${name}' is already listed.`;
  return null;
}

/** The route key for every loop of the project without a route of its own. */
export const DEFAULT_ROUTE = "default";

/**
 * Labels no loop takes: with Jav on, their tickets would never be picked.
 *
 * `loops` is the loops a route may name — `JavReport.loops`, the routable ones.
 * Resolved through each loop's own route then `DEFAULT_ROUTE`, exactly as
 * `validateJav` does, so the warning this drives and the refusal the save
 * returns cannot disagree: a `default` route drains a label only when some
 * routable loop actually falls back to it.
 */
export const strandedLabels = (config: JavConfigView, loops: readonly string[]): string[] => {
  const taken = new Set(loops.flatMap((loop) => config.routes[loop] ?? config.routes[DEFAULT_ROUTE] ?? []));
  return config.labels.filter((label) => !taken.has(label));
};

/**
 * Loops that take nothing — no route of their own and no `default` route to
 * fall back on: with Jav on, they wait for work that never comes.
 */
export const idleLoops = (config: JavConfigView, loops: readonly string[]): string[] =>
  loops.filter((loop) => (config.routes[loop] ?? config.routes[DEFAULT_ROUTE] ?? []).length === 0);

/**
 * Whether routing is on with a backlog nobody is going to label (#147).
 *
 * With Jav on, a ticket carrying no difficulty label is invisible to every
 * coder — and labelling it is the triager's job. A project that turns routing
 * on and staffs no triager has therefore built a queue with no drain, and the
 * only place that is visible is this page.
 *
 * An unknown untriaged count (`null`, the frontier could not be read) is not
 * evidence, so it does not warn: a warning on a failed read would cry wolf
 * every time the tracker was slow.
 */
export const needsTriager = (
  config: JavConfigView,
  intake: { untriaged: number | null; triagers: readonly string[] },
): boolean => config.enabled && (intake.untriaged ?? 0) > 0 && intake.triagers.length === 0;

export const sameConfig = (a: JavConfigView, b: JavConfigView): boolean => JSON.stringify(a) === JSON.stringify(b);
