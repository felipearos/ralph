#!/usr/bin/env bun
/**
 * Jav — difficulty routing: which loop takes which kind of ticket.
 *
 * A triager labels each `ready-for-agent` ticket with a difficulty label
 * (`difficulty:easy`, `difficulty:hard`, …). Jav maps loops to those labels,
 * so a loop running a frontier model can take the hard work while a loop on a
 * small model takes only the easy work. It lives in the harness, beside
 * `models.json`, because it is about the loops and their lineups rather than
 * about any one project's code — but it is keyed by project, because loop
 * names repeat across projects and one project's routing must not bleed into
 * another's.
 *
 * `jav.json` holds one block per project, keyed by project id, and an optional
 * `default` block for a project with none:
 *
 *   {
 *     "loggd": {
 *       "enabled": true,
 *       "labels": ["difficulty:easy", "difficulty:hard"],
 *       "routes": { "ralph": ["difficulty:hard"], "default": ["difficulty:easy"] }
 *     }
 *   }
 *
 * A loop's labels resolve `project.routes.<loop>` → `project.routes.default`,
 * in the project's block, else in the `default` block. Off (or no block, or no
 * file at all), every loop picks from the whole frontier, exactly as before
 * Jav. On, a loop picks only tickets carrying one of ITS labels. A ticket
 * carrying none of the configured labels is untriaged and nobody picks it:
 * misrouting a hard ticket to a small model costs more than a ticket that
 * waits for triage. The one exception is a ticket routing would strand that
 * nobody can triage — a ci-doctor or learning-fix filing (`ROUTING_EXEMPT_LABELS`), which every
 * loop is offered instead. A loop with no route picks nothing and its gate
 * waits.
 *
 * The file before project keys was one unkeyed block. Such a file is read as
 * `loggd`'s block (`LEGACY_PROJECT`), values unchanged, and the first save
 * writes it back keyed. Reads never write: the frontier's pick and the
 * dashboard's view stay read-only. An unkeyed block beside a `loggd` one is
 * refused rather than guessed at.
 *
 * Routing is about CODERS. A triager or a ci-doctor never takes frontier work,
 * so it can hold no route and does not count when Jav checks that every
 * difficulty label is drained: a `default` route only drains a label if some
 * coder actually falls back to it. Claim-label reservation runs the other way
 * and spans the whole roster — every loop's `-wip`/`-blocked`/`-done` means
 * something whatever its role, so none of them may be routed on.
 *
 * Validation is strict and total, like `.ralph/config.json`: an unknown key is
 * refused, and every problem is collected so one save reports all of them.
 *
 * Usage (for the project at `RALPH_PROJECT`, keyed `RALPH_PROJECT_ID`):
 *   bun jav.ts --json     the project's block, its problems and roster, as JSON
 *   bun jav.ts --save     validate the block on stdin; write it only when valid
 *
 * The file is `RALPH_JAV` when set, else `jav.json` in `RALPH_HOME`. The env
 * comes first because `frontier/next.ts` runs a pinned copy of the frontier out
 * of a temp directory, where this file's own location is not the harness.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RALPH_HOME } from "./paths";
import type { RosterEntry } from "./project-config";
import { roleDescriptor, type Role } from "./roles";
import { LEGACY_PROJECT, PROJECT_ID } from "./project-id";

/** One project's routing. */
export interface JavConfig {
  enabled: boolean;
  /** The difficulty labels a triager applies, in the order the page lists them. */
  labels: string[];
  /** Loop name (or `default`, for any loop without its own) → the labels that loop takes. */
  routes: Record<string, string[]>;
}

export interface JavVerdict {
  /** The config when it is valid, else null. */
  config: JavConfig | null;
  problems: string[];
}

export const DEFAULT_JAV: JavConfig = { enabled: false, labels: [], routes: {} };

/** The block a project without its own falls back to. */
export const DEFAULT_BLOCK = "default";

const KEYS = ["enabled", "labels", "routes"];

/**
 * A roster as Jav reads it: bare names, or entries carrying a role, in any mix.
 * A bare name is a coder, which is both `project-config`'s rule for the file
 * and the judgement every caller made before roles existed — so a caller that
 * still passes names keeps exactly the routing it had. Spelled as an element
 * union rather than a union of array types: `readonly string[]` and
 * `readonly RosterEntry[]` are both assignable to it, and the helpers below can
 * then map over it without a cast.
 */
export type JavRoster = readonly (string | RosterEntry)[];

const nameOf = (entry: string | RosterEntry): string => (typeof entry === "string" ? entry : entry.name);

/** Every roster name, in roster order, whatever its role. */
export function rosterNames(roster: JavRoster): string[] {
  return roster.map(nameOf);
}

/**
 * The names that may hold a route, in roster order.
 *
 * Read off the role's descriptor (`javRouted`) rather than off `role ===
 * "coder"`, so this and the frontier — which gates a loop's route on the same
 * field — cannot come to disagree: a role added later with `javRouted: true`
 * would otherwise be offered a route by the frontier and refused one here.
 */
export function routableLoops(roster: JavRoster): string[] {
  return roster.filter((entry) => typeof entry === "string" || roleDescriptor(entry.role).javRouted).map(nameOf);
}

/** `loop`'s role when the roster carries one, else null — it is a bare name, hence a coder. */
const roleIn = (roster: JavRoster, loop: string): Role | null => {
  const entry = roster.find((candidate) => nameOf(candidate) === loop);
  return entry === undefined || typeof entry === "string" ? null : entry.role;
};

/**
 * The labels a ci-doctor filing for the coders carries that are not already
 * reserved for another reason — `CODER_FILING_LABELS` in
 * `ci-doctor/case-issue.ts` plus the `priority:urgent` its regression path adds,
 * less `ready-for-agent`. A project may route on none of them.
 *
 * Reserved for a sharper reason than tidiness. The routing exemption
 * (`ROUTING_EXEMPT_LABELS`) fires only for a ticket carrying NONE of the
 * configured difficulty labels, so configuring any label a filing already
 * carries puts a configured label on every filing: the exemption stops seeing
 * them as stranded and silently never fires again, which is the broken
 * behaviour of felipearos/ralph#233 back with nothing to show it. `bug` is in
 * here for exactly that reason and not because it is a claim marker.
 */
const FILING_LABELS: readonly string[] = ["ci-health", "bug", "priority:urgent", "learning-fix"];

/**
 * Labels the loop already gives a meaning to. Routing on one would tie a
 * loop's work to a claim or a queue marker rather than to a difficulty. Every
 * roster name counts, whatever its role: a triager's claim label fences coders
 * off an issue exactly as a coder's does.
 *
 * `FILING_LABELS` is in here too, for its own reason — see there, and see
 * `reservedWhy` for how the refusal says which reason applies.
 */
export function reservedLabels(roster: JavRoster): string[] {
  return [
    // `ready-for-agent` is a filing label too, and already reserved for the
    // older reason: it is the queue itself, so its refusal keeps that wording.
    "ready-for-agent",
    "spec",
    ...FILING_LABELS,
    ...rosterNames(roster).flatMap((loop) => [`${loop}-wip`, `${loop}-blocked`, `${loop}-done`]),
  ];
}

/**
 * Why this label is refused as a difficulty label. Two different reasons, and an
 * operator reading the Routing page needs the one that applies: a claim label is
 * refused because it means something else, a filing label because routing on it
 * would turn the ci-doctor's lane off.
 */
export function reservedWhy(label: string): string {
  return FILING_LABELS.includes(label)
    ? `'${label}' is on every ci-doctor filing; routing on it would switch off the urgent lane's exemption`
    : `'${label}' is a label the loop already uses; pick a difficulty label`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Judge one project's block against that project's roster. A route may name
 * any CODER on the roster, or `default` for every coder without a route of its
 * own; a non-coder is refused, since routing frontier tickets to a loop that
 * never picks from the frontier is a route nobody reads.
 */
export function validateJav(value: unknown, roster: JavRoster): JavVerdict {
  const problems: string[] = [];
  if (!isRecord(value)) return { config: null, problems: ["a Jav block must be a JSON object"] };

  for (const key of Object.keys(value)) {
    if (!KEYS.includes(key)) problems.push(`unknown key '${key}'`);
  }

  if (typeof value.enabled !== "boolean") problems.push("'enabled' must be true or false");

  const labels: string[] = [];
  if (!Array.isArray(value.labels)) {
    problems.push("'labels' must be an array of label names");
  } else {
    const reserved = new Set(reservedLabels(roster));
    for (const label of value.labels) {
      if (typeof label !== "string" || label.trim() === "") {
        problems.push("every label must be a non-empty string");
      } else if (label !== label.trim()) {
        problems.push(`label '${label}' has leading or trailing spaces`);
      } else if (reserved.has(label)) {
        problems.push(reservedWhy(label));
      } else if (labels.includes(label)) {
        problems.push(`label '${label}' is listed twice`);
      } else {
        labels.push(label);
      }
    }
  }

  const routes: Record<string, string[]> = {};
  if (!isRecord(value.routes)) {
    problems.push("'routes' must be an object of loop name → labels");
  } else {
    const targets = routableLoops(roster);
    // A roster of nothing but non-coders offers only `default`; naming the
    // empty coder list would read as a stray comma.
    const offer = targets.length === 0 ? DEFAULT_BLOCK : `${targets.join(", ")}, or ${DEFAULT_BLOCK}`;
    for (const [loop, taken] of Object.entries(value.routes)) {
      if (loop !== DEFAULT_BLOCK && !targets.includes(loop)) {
        // Two different mistakes, and two different fixes: a name nobody knows
        // is a typo or a loop yet to be added, while a name the roster carries
        // under another role is a misunderstanding of what Jav routes.
        const role = roleIn(roster, loop);
        problems.push(
          role === null
            ? `'${loop}' is not a loop (${offer})`
            : `'${loop}' is a ${role}, which never takes frontier work; route targets are ${offer}`,
        );
        continue;
      }
      if (!Array.isArray(taken) || taken.some((label) => typeof label !== "string")) {
        problems.push(`routes.${loop} must be an array of label names`);
        continue;
      }
      const unique = [...new Set(taken as string[])];
      for (const label of unique) {
        if (!labels.includes(label)) problems.push(`routes.${loop} names '${label}', which is not in 'labels'`);
      }
      routes[loop] = unique;
    }
  }

  // An enabled Jav that strands a label is a queue nobody drains: the triager
  // keeps labelling tickets no loop will ever pick. Asked of the coders alone,
  // and through the same fallback `javLabelsFor` resolves — a `default` route
  // drains a label only if some coder actually falls back to it, so a project
  // whose every coder has a route of its own strands whatever only `default`
  // takes, however many non-coders sit on the roster.
  if (value.enabled === true) {
    if (labels.length === 0) problems.push("Jav is on but no labels are configured");
    const taken = new Set(routableLoops(roster).flatMap((loop) => routes[loop] ?? routes[DEFAULT_BLOCK] ?? []));
    for (const label of labels) {
      if (!taken.has(label)) {
        problems.push(`no loop takes '${label}', so its tickets would never be picked`);
      }
    }
  }

  if (problems.length > 0) return { config: null, problems };
  return { config: { enabled: value.enabled as boolean, labels, routes }, problems };
}

/**
 * The labels this loop may pick, or null when Jav is off and it may pick
 * anything. An empty array is a real answer: Jav is on and this loop has no
 * route, so it picks nothing.
 */
export function javLabelsFor(config: JavConfig, loop: string): string[] | null {
  if (!config.enabled) return null;
  return config.routes[loop] ?? config.routes[DEFAULT_BLOCK] ?? [];
}

/**
 * Labels that take a ticket OUT of difficulty routing WHEN routing would
 * otherwise strand it: routing keeps such a ticket for every loop that takes
 * anything, rather than dropping it for all of them.
 *
 * These are the ci-doctor's filings for the coders, and the exemption exists
 * because routing them is the opposite of what both labels are for.
 * `priority:urgent` is the frontier's one priority lane and the ci-doctor is
 * its only writer: a red base branch blocks the merge queue for every loop, so
 * a lane whose tickets routing hands to nobody is a lane that does nothing. And
 * the doctor cannot know a regression's difficulty — "revert this culprit or fix
 * forward" is not knowable from the failure — so the alternative, letting it
 * label its own filings, would be wrong by construction rather than sometimes.
 *
 * `ci-health` is what makes the exemption cover EVERY coder-facing filing and
 * not merely the urgent one: `CODER_FILING_LABELS`
 * (`ci-doctor/case-issue.ts`) is `ci-health`, `ready-for-agent`, `bug`, so the
 * out-of-scope filing, the forward fix and the `fix-failed` hand-off are all
 * caught by the same rule. The doctor's own case issues carry `ci-health` too,
 * but they carry no `ready-for-agent` and so reach no coder's frontier anyway.
 *
 * Deliberately recognised by LABEL rather than by author: the frontier has no
 * notion of who filed a ticket, and a human who files a regression by hand with
 * these labels deserves the same lane.
 *
 * The exemption is NARROW, and `routeByDifficulty` is where that is enforced: it
 * rescues only a ticket routing would STRAND — one carrying none of the
 * project's configured difficulty labels. An urgent ticket a triager has called
 * `difficulty:hard` is still filtered away from an easy-only loop, because some
 * loop does take it and the lane puts it first there; routing it everywhere
 * would hand hard work to a small model on the strength of its urgency, which
 * is what `frontier/next-tasks.test.ts`'s "is still filtered out by a route that
 * does not take it" has pinned since #153.
 *
 * These labels are string literals here, and must stay literals, for two different
 * reasons. `URGENT_LABEL` lives in `frontier/next-tasks.ts`, which imports this
 * module at runtime, so importing it back would be a real cycle. `CASE_LABEL`
 * lives in `ci-doctor/case-issue.ts`, which reaches this module only through a
 * type-only import, so that one would NOT cycle — it would instead make this
 * leaf pull the ci-doctor's store, lease and `gh` graph in for one string, which
 * is the cost `store.ts` was made to carry the day grammar to avoid.
 *
 * What keeps them honest is `jav.test.ts`, which imports BOTH owners and
 * compares: a test may depend on what a leaf may not. `roles.ts` keeps its own
 * `priority:urgent` literal for the same reason, but pins it literal against
 * literal, so a rename there would pass.
 *
 * Not configurable, and not meant to be: a project that could route its urgent
 * lane away would be a project whose red base branch waits on triage.
 */
export const ROUTING_EXEMPT_LABELS: readonly string[] = ["priority:urgent", "ci-health", "learning-fix"];

/**
 * Whether these labels are a candidate for the exemption. The label half of the
 * rule only: `routeByDifficulty` adds the other half, that nothing in the
 * project's configured difficulty labels is on the ticket.
 */
export function isRoutingExempt(labels: ReadonlySet<string>): boolean {
  return ROUTING_EXEMPT_LABELS.some((label) => labels.has(label));
}

/**
 * Keep the tickets this loop may pick, in the order given: the ones carrying one
 * of `labels`, plus the ones routing would strand — an exempt ticket
 * (`ROUTING_EXEMPT_LABELS`) carrying none of the project's `configured`
 * difficulty labels at all.
 *
 * `configured` is the project's whole `labels` list, not this loop's route,
 * because "stranded" is a fact about the project: a ticket some other loop takes
 * is not stranded, and only a ticket no route can match needs rescuing.
 *
 * A loop with NO route still picks nothing, exemption included. An empty route
 * is not a narrow route — it is a loop Jav holds out of the rotation entirely,
 * whose gate waits — and handing it the urgent lane would start work on a loop
 * the configuration says is not taking any.
 */
export function routeByDifficulty<T extends { labels: Set<string> }>(
  tickets: T[],
  labels: string[] | null,
  configured: readonly string[],
): T[] {
  if (labels === null) return tickets;
  if (labels.length === 0) return [];
  const stranded = (ticket: T): boolean =>
    isRoutingExempt(ticket.labels) && !configured.some((label) => ticket.labels.has(label));
  return tickets.filter((ticket) => labels.some((label) => ticket.labels.has(label)) || stranded(ticket));
}

export function javPath(env: Record<string, string | undefined> = process.env): string {
  const override = env.RALPH_JAV?.trim();
  if (override) return override;
  return join(env.RALPH_HOME?.trim() || RALPH_HOME, "jav.json");
}

/** The file before project keys: one block, unkeyed, at the top level. */
const isLegacy = (value: Record<string, unknown>): boolean => KEYS.some((key) => key in value);

/**
 * The file with its unkeyed legacy block moved under `loggd`, or null when it
 * is already keyed by project. Values are carried over untouched: a route
 * that worked before the move works the same after it.
 */
export function migrateJav(value: unknown): Record<string, unknown> | null {
  // Beside a `loggd` block there is no telling which wins: left as written,
  // for `fileProblems` to refuse.
  if (!isRecord(value) || !isLegacy(value) || LEGACY_PROJECT in value) return null;
  const block: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) (KEYS.includes(key) ? block : rest)[key] = entry;
  return { [LEGACY_PROJECT]: block, ...rest };
}

/** Problems with the file's shape: every key a project id or `default`, every value an object. */
export function fileProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["jav.json must be a JSON object keyed by project id"];
  const problems: string[] = [];
  for (const [key, block] of Object.entries(value)) {
    if (KEYS.includes(key)) {
      problems.push(`'${key}' is not keyed by project; move it into a project's block`);
    } else if (key !== DEFAULT_BLOCK && !PROJECT_ID.test(key)) {
      problems.push(`'${key}' is not a project id`);
    } else if (!isRecord(block)) {
      problems.push(`'${key}' must be a Jav block`);
    }
  }
  return problems;
}

/** What the file on disk says, before any judgement: absent, unparseable, or a value. */
type RawRead = { exists: false } | { exists: true; value: unknown } | { exists: true; parseError: string };

/**
 * Read the file, a legacy one as the keyed file it migrates to. Nothing is
 * written here; `saveJav` persists the keyed shape.
 */
function readRaw(path: string): RawRead {
  if (!existsSync(path)) return { exists: false };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    return { exists: true, parseError: error instanceof Error ? error.message : String(error) };
  }
  return { exists: true, value: migrateJav(value) ?? value };
}

/** The block a project routes by: its own, else `default`, else none. */
function blockFor(file: Record<string, unknown>, project: string): { value: unknown; own: boolean } | null {
  if (project in file) return { value: file[project], own: true };
  if (DEFAULT_BLOCK in file) return { value: file[DEFAULT_BLOCK], own: false };
  return null;
}

/**
 * The routing the frontier applies to this project. No file, or no block for
 * the project, is Jav off. A broken file or block THROWS rather than falling
 * back to off: silently routing every ticket to every loop is the misrouting
 * Jav exists to prevent, and `--take-one` reports the throw as its `error`,
 * which the prompt treats as a fault rather than an empty frontier.
 */
export function readJav(path: string, project: string, roster: JavRoster): JavConfig {
  const raw = readRaw(path);
  if (!raw.exists) return DEFAULT_JAV;
  if ("parseError" in raw) throw new Error(`${path} is not valid JSON: ${raw.parseError}`);
  const shape = fileProblems(raw.value);
  if (shape.length > 0) throw new Error(`${path} is invalid: ${shape.join("; ")}`);
  const block = blockFor(raw.value as Record<string, unknown>, project);
  if (block === null) return DEFAULT_JAV;
  const verdict = validateJav(block.value, roster);
  const name = block.own ? project : DEFAULT_BLOCK;
  if (verdict.config === null) throw new Error(`${path} '${name}' is invalid: ${verdict.problems.join("; ")}`);
  return verdict.config;
}

/** Write through a temp file and a rename, so a reader never sees half a file. */
function writeFile(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

/**
 * Write one project's block, leaving every other project's exactly as it was.
 * The block is judged first; a refused one writes nothing.
 */
export function saveJav(path: string, project: string, value: unknown, roster: JavRoster): JavVerdict {
  const verdict = validateJav(value, roster);
  if (verdict.config === null) return verdict;
  const raw = readRaw(path);
  if (raw.exists && "parseError" in raw) {
    return { config: null, problems: [`${path} is not valid JSON (${raw.parseError}); fix it by hand first`] };
  }
  const file = raw.exists && isRecord(raw.value) ? { ...raw.value } : {};
  file[project] = verdict.config;
  writeFile(path, file);
  return verdict;
}

/** What `--json` prints. */
export interface JavReport {
  path: string;
  exists: boolean;
  /** The project this report is for. */
  project: string;
  /** True when the project has a block of its own; false when it falls back to `default` or to off. */
  own: boolean;
  /** The block the project routes by, as written when it parses, else the default. The page edits this. */
  config: unknown;
  problems: string[];
  /** The loops a route may name: the coders, in roster order. The page lists one row each. */
  loops: string[];
  /**
   * Labels no route may use, over the WHOLE roster — a non-coder's claim triple
   * included, and the ci-doctor's filing labels with it (`reservedWhy` says
   * which reason a given one is refused for). The page lists them as a block, so
   * it needs no separation of the two kinds.
   */
  reserved: string[];
}

export function javReport(path: string, project: string, roster: JavRoster): JavReport {
  const base = { path, project, loops: routableLoops(roster), reserved: reservedLabels(roster) };
  const raw = readRaw(path);
  if (!raw.exists) return { ...base, exists: false, own: false, config: DEFAULT_JAV, problems: [] };
  if ("parseError" in raw) {
    return { ...base, exists: true, own: false, config: DEFAULT_JAV, problems: [`not valid JSON: ${raw.parseError}`] };
  }
  const shape = fileProblems(raw.value);
  if (shape.length > 0) return { ...base, exists: true, own: false, config: DEFAULT_JAV, problems: shape };
  const block = blockFor(raw.value as Record<string, unknown>, project);
  if (block === null) return { ...base, exists: true, own: false, config: DEFAULT_JAV, problems: [] };
  return { ...base, exists: true, own: block.own, config: block.value, problems: validateJav(block.value, roster).problems };
}

async function main(): Promise<void> {
  // Imported here rather than at the top: the frontier imports this module,
  // and only the CLI needs the project's id and roster.
  const { projectRoot } = await import("./paths");
  const { currentProjectId, projectRosterEntries } = await import("./roster");
  const root = projectRoot();
  const project = currentProjectId(root);
  // Entries, not names: the CLI is what the dashboard's Jav page reads, and a
  // page offering a triager a route row would offer an edit `--save` refuses.
  const roster = projectRosterEntries(root);
  const path = javPath();
  const flag = process.argv[2];
  if (flag === "--json") {
    console.log(JSON.stringify(javReport(path, project, roster)));
    return;
  }
  if (flag === "--save") {
    let value: unknown;
    try {
      value = JSON.parse(await Bun.stdin.text());
    } catch {
      console.log(JSON.stringify({ valid: false, problems: ["the candidate is not valid JSON"] }));
      return;
    }
    const verdict = saveJav(path, project, value, roster);
    console.log(JSON.stringify({ valid: verdict.config !== null, problems: verdict.problems }));
    return;
  }
  console.error("usage: bun jav.ts --json | --save < block.json");
  process.exitCode = 2;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`jav: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
