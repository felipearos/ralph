#!/usr/bin/env bun
/**
 * What each harness can run: the model ids and effort levels it offers.
 *
 * `models.json` accepts any well-formed id, so the lineup editor needs a
 * separate answer to "which ids exist?", and the only honest source is the
 * harness itself. Each runner is asked in the way it can be asked:
 *
 *   claude     the model catalog baked into the Claude Code binary — the one
 *              its `/model` picker and unknown-model check read — plus
 *              `claude --help` for the effort levels the CLI accepts.
 *   opencode   `opencode models`, the same command its own error text points at.
 *   codex      `~/.codex/models_cache.json`, the catalogue Codex fetched on its
 *              last run — slugs listed as visible, with their reasoning levels.
 *
 * A harness that is missing, unauthenticated or slow is reported as
 * unavailable with a reason, never as an empty catalogue that looks like a
 * harness with no models. The output is JSON only; the lineup adapter narrows
 * it, and the form draws its pickers from it.
 */
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CatalogModel {
  id: string;
  /** Replacement recommended by the harness for an older model. */
  upgradeTo?: string;
  label?: string;
  /** The effort levels this model accepts, when the harness reports them per model. */
  efforts?: string[];
  /** Tokens of context, when the harness reports it. */
  contextWindow?: number;
}

export interface RunnerCatalog {
  available: boolean;
  /** Why the harness could not be asked, when `available` is false. */
  reason: string | null;
  /** How the list was obtained, for the operator's benefit. */
  source: string;
  version: string | null;
  models: CatalogModel[];
  /** The effort levels the harness accepts for a stage that takes one. */
  efforts: string[];
  /** Alias to the id it resolves to, for a harness that has aliases. */
  aliases?: Record<string, string>;
}

export interface HarnessCatalog {
  fetchedAt: string;
  runners: Record<string, RunnerCatalog>;
}

const unavailable = (source: string, reason: string): RunnerCatalog => ({
  available: false,
  reason,
  source,
  version: null,
  models: [],
  efforts: [],
});

function run(
  command: string,
  args: string[],
  options: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv } = { timeoutMs: 20_000 },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024, cwd: options.cwd, env: options.env ?? process.env },
      (error, stdout, stderr) => {
        resolve({ ok: error === null, stdout: String(stdout), stderr: String(stderr || (error?.message ?? "")) });
      },
    );
  });
}

/** `(low, medium, high, xhigh, max)` after `--effort`, as the CLI prints it. */
export function parseClaudeEfforts(help: string): string[] {
  const match = /--effort\s+<level>[\s\S]*?\(([^)]+)\)/.exec(help);
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((level) => level.trim())
    .filter((level) => /^[a-z]+$/.test(level));
}

/** One model as Claude Code's own baked catalog describes it. */
export interface ClaudeCatalog {
  models: CatalogModel[];
  /** `latest_per_family`: what each alias resolves to in this build. */
  aliases: Record<string, string>;
}

/**
 * Claude Code has no list command, but its binary bakes in the catalog the
 * `/model` picker and the unknown-model check read: one record per id with the
 * display name, context window, capabilities and default effort, plus the
 * alias-to-latest map. The records are a minified JS array literal, so they
 * are read with the same shape-anchored patterns a grep would use, and every
 * field is optional except the id and name the anchor itself matched.
 */
export function parseClaudeCatalog(text: string): ClaudeCatalog {
  const anchor = /\{id:"(claude-[a-z0-9-]+)",family:"[a-z]+",display_name:"([^"]*)"/g;
  const starts: { index: number; id: string; name: string }[] = [];
  for (const match of text.matchAll(anchor)) {
    starts.push({ index: match.index, id: match[1]!, name: match[2]! });
  }
  const seen = new Map<string, CatalogModel>();
  starts.forEach((start, position) => {
    if (seen.has(start.id)) return;
    const end = position + 1 < starts.length ? starts[position + 1]!.index : start.index + 4000;
    const record = text.slice(start.index, Math.min(end, start.index + 4000));
    const window = /context:\{window:([0-9.e]+)/.exec(record)?.[1];
    const capabilities = (/capabilities:\[([^\]]*)\]/.exec(record)?.[1] ?? "")
      .split(",")
      .map((item) => item.replace(/"/g, "").trim())
      .filter(Boolean);
    const efforts = capabilities.includes("effort")
      ? ["low", "medium", "high", ...(capabilities.includes("xhigh_effort") ? ["xhigh"] : []), ...(capabilities.includes("max_effort") ? ["max"] : [])]
      : [];
    seen.set(start.id, {
      id: start.id,
      label: start.name,
      ...(efforts.length > 0 ? { efforts } : {}),
      ...(window !== undefined && Number.isFinite(Number(window)) ? { contextWindow: Number(window) } : {}),
    });
  });
  const aliases: Record<string, string> = {};
  const latest = /latest_per_family:\{([^}]*)\}/.exec(text)?.[1] ?? "";
  for (const pair of latest.matchAll(/([a-z]+):"(claude-[a-z0-9-]+)"/g)) aliases[pair[1]!] = pair[2]!;
  // The binary lists oldest first; the picker wants the newest at the top.
  return { models: [...seen.values()].reverse(), aliases };
}

/** `2.1.327` against `2.1.40`, numerically: the order Claude Code's updater installs builds in. */
const compareVersionNames = (a: string, b: string): number => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

/**
 * Where the Claude Code binary may be, most likely first: what `claude` on
 * PATH resolves to, then the newest build the native installer keeps under
 * `~/.local/share/claude/versions/`.
 *
 * The second is not a guess but the case this exists for: `claude` on PATH
 * may be a wrapper script (an account router, a version pin) that execs the
 * real binary, and a wrapper carries no catalog. Reading only the PATH entry
 * reported "its layout may have changed" on such a host while the binary next
 * to it held the catalog intact.
 */
export function claudeBinaryCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const found: string[] = [];
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir === "") continue;
    const entry = join(dir, "claude");
    if (!existsSync(entry)) continue;
    try {
      found.push(realpathSync(entry));
    } catch {
      // A dangling link: the installer's builds below may still be there.
    }
    break;
  }
  const versions = join(env.HOME ?? homedir(), ".local", "share", "claude", "versions");
  try {
    const newest = readdirSync(versions)
      .filter((name) => /^\d+(?:\.\d+)*$/.test(name))
      .sort(compareVersionNames)
      .pop();
    if (newest !== undefined) found.push(join(versions, newest));
  } catch {
    // No native install on this host.
  }
  return [...new Set(found)];
}

const LATEST_ANCHOR = Buffer.from("latest_per_family:{", "latin1");

/**
 * The `latest_per_family` map out of one file, read in chunks rather than
 * whole: the binary is hundreds of megabytes and the map is a few hundred
 * bytes, and a caller at loop start must not hold the whole bundle as a
 * string to learn which id `opus` means. Null when the file has no such map.
 */
export function scanLatestPerFamily(path: string): Record<string, string> | null {
  const CHUNK = 8 * 1024 * 1024;
  // Enough of the previous chunk is kept that an anchor and its map split
  // across a boundary are still read whole.
  const KEEP = 4096;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = statSync(path).size;
    let carry = Buffer.alloc(0);
    for (let offset = 0; offset < size; ) {
      const chunk = Buffer.alloc(Math.min(CHUNK, size - offset));
      const read = readSync(fd, chunk, 0, chunk.length, offset);
      if (read <= 0) break;
      offset += read;
      const window = Buffer.concat([carry, chunk.subarray(0, read)]);
      carry = window.subarray(Math.max(0, window.length - KEEP));
      // Every anchor in the window, not only the first: an anchor with no map
      // after it (a string, a minifier artefact) must not hide the real one.
      for (let at = window.indexOf(LATEST_ANCHOR); at >= 0; at = window.indexOf(LATEST_ANCHOR, at + 1)) {
        const end = window.indexOf("}", at + LATEST_ANCHOR.length);
        if (end < 0 || end - at > KEEP) {
          // The brace may be in the next chunk: carry from the anchor, but
          // never more than KEEP, so a stray anchor cannot make the carry
          // grow chunk by chunk to the size of the binary.
          if (window.length - at <= KEEP && offset < size) carry = window.subarray(at);
          continue;
        }
        const body = window.subarray(at + LATEST_ANCHOR.length, end).toString("latin1");
        const map: Record<string, string> = {};
        for (const pair of body.matchAll(/([a-z]+):"(claude-[a-z0-9-]+)"/g)) map[pair[1]!] = pair[2]!;
        if (Object.keys(map).length > 0) return map;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * What each Claude alias resolves to in the installed Claude Code, and the
 * file that said so, or null when no candidate binary carries the map. No
 * process is run: `model-updates.ts` asks this at every loop start.
 */
export function readClaudeLatest(env: NodeJS.ProcessEnv = process.env): { latest: Record<string, string>; source: string } | null {
  for (const candidate of claudeBinaryCandidates(env)) {
    const latest = scanLatestPerFamily(candidate);
    if (latest !== null) return { latest, source: candidate };
  }
  return null;
}

async function claudeCatalog(): Promise<RunnerCatalog> {
  const help = await run("claude", ["--help"]);
  if (!help.ok) return unavailable("claude --help", `claude --help failed: ${help.stderr.trim() || "not on PATH"}`);
  const version = await run("claude", ["--version"]);
  const candidates = claudeBinaryCandidates();
  let source = `${candidates[0] ?? "claude"}: baked model catalog`;
  let catalog: ClaudeCatalog = { models: [], aliases: {} };
  let unreadable: string | null = null;
  // The first candidate that carries a catalog wins; a wrapper script on PATH
  // reads as one with no catalog and the installer's build is tried next.
  for (const candidate of candidates) {
    try {
      catalog = parseClaudeCatalog(readFileSync(candidate, "latin1"));
    } catch (error) {
      unreadable = (error as Error).message;
      continue;
    }
    source = `${candidate}: baked model catalog`;
    if (catalog.models.length > 0) break;
  }
  if (catalog.models.length === 0) {
    if (unreadable !== null && candidates.length === 1) {
      return unavailable(source, `could not read the Claude Code binary: ${unreadable}`);
    }
    return unavailable(source, "no model catalog found in the Claude Code binary; its layout may have changed");
  }
  return {
    available: true,
    reason: null,
    source,
    version: version.ok ? version.stdout.trim() : null,
    models: [
      ...Object.entries(catalog.aliases).map(([alias, target]) => ({ id: alias, label: `alias for ${target}` })),
      ...catalog.models,
    ],
    efforts: parseClaudeEfforts(help.stdout),
    aliases: catalog.aliases,
  };
}

async function opencodeCatalog(): Promise<RunnerCatalog> {
  const source = "opencode models";
  const list = await run("opencode", ["models"], { timeoutMs: 45_000 });
  if (!list.ok) return unavailable(source, `opencode models failed: ${list.stderr.trim() || "not on PATH"}`);
  const version = await run("opencode", ["--version"]);
  const models = list.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:@[\]-]+$/.test(line))
    .map((id) => ({ id }));
  if (models.length === 0) return unavailable(source, "opencode models printed no provider/model lines");
  return { available: true, reason: null, source, version: version.ok ? version.stdout.trim() : null, models, efforts: [] };
}

interface CodexCacheModel {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  supported_reasoning_levels?: unknown;
  upgrade?: unknown;
}

export function parseCodexCache(text: string): { models: CatalogModel[]; efforts: string[] } {
  const parsed = JSON.parse(text) as { models?: unknown };
  const raw = Array.isArray(parsed.models) ? (parsed.models as CodexCacheModel[]) : [];
  const models: CatalogModel[] = [];
  const efforts = new Set<string>();
  for (const entry of raw) {
    if (typeof entry.slug !== "string" || entry.visibility === "hide") continue;
    const levels = Array.isArray(entry.supported_reasoning_levels)
      ? (entry.supported_reasoning_levels as { effort?: unknown }[])
          .map((level) => level.effort)
          .filter((effort): effort is string => typeof effort === "string")
      : [];
    levels.forEach((level) => efforts.add(level));
    models.push({
      id: entry.slug,
      ...(entry.upgrade && typeof entry.upgrade === "object" && "model" in entry.upgrade && typeof entry.upgrade.model === "string"
        ? { upgradeTo: entry.upgrade.model } : {}),
      ...(typeof entry.display_name === "string" ? { label: entry.display_name } : {}),
      ...(levels.length > 0 ? { efforts: levels } : {}),
    });
  }
  return { models, efforts: [...efforts] };
}

async function codexCatalog(): Promise<RunnerCatalog> {
  const path = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "models_cache.json");
  const source = path;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return unavailable(source, `no ${path}; run codex once so it fetches its model catalogue`);
  }
  let catalog: { models: CatalogModel[]; efforts: string[] };
  try {
    catalog = parseCodexCache(text);
  } catch (error) {
    return unavailable(source, `${path} is not the catalogue shape: ${(error as Error).message}`);
  }
  const version = await run("codex", ["--version"]);
  return { available: true, reason: null, source, version: version.ok ? version.stdout.trim() : null, ...catalog };
}

export async function readHarnessCatalog(): Promise<HarnessCatalog> {
  const [claude, opencode, codex] = await Promise.all([claudeCatalog(), opencodeCatalog(), codexCatalog()]);
  return { fetchedAt: new Date().toISOString(), runners: { claude, opencode, codex } };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!args.includes("--json")) {
    console.error("usage: bun harness-catalog.ts --json");
    process.exit(2);
  }
  readHarnessCatalog().then(
    (catalog) => console.log(JSON.stringify(catalog, null, 2)),
    (error: unknown) => {
      console.error(`harness-catalog: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
