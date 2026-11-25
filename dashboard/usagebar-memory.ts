/**
 * The UsageBar reading the dashboard last saw, kept in the operator's cache
 * directory so it outlives a restart (`usagebar-adapter.ts` says why).
 *
 * The file holds what the page already shows: limit windows, the plan and
 * the account name. No token, no loop state; deleting it only costs the stale
 * bars until the next good read. Written atomically, user-only: the directory
 * is narrowed to its owner, and the temporary file is created exclusively, so
 * a link planted at its name fails the save instead of being written through.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { UsageBarView } from "./contracts";

/** `$XDG_CACHE_HOME/ralph-dashboard/usagebar.json`, else under `~/.cache`. */
export function usageBarMemoryPath(env: Record<string, string | undefined> = process.env): string {
  const xdg = env.XDG_CACHE_HOME?.trim();
  const cache = xdg !== undefined && xdg !== "" && isAbsolute(xdg) ? xdg : join(env.HOME?.trim() || homedir(), ".cache");
  return join(cache, "ralph-dashboard", "usagebar.json");
}

export function createUsageBarFileMemory(path: string = usageBarMemoryPath()): {
  load(): unknown;
  save(view: UsageBarView): void;
} {
  return {
    load() {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return null;
      }
    },
    save(view) {
      const dir = join(path, "..");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const temp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify(view), { mode: 0o600, flag: "wx" });
        renameSync(temp, path);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    },
  };
}
