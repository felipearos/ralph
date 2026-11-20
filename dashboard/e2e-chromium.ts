/**
 * The chromium a browser suite drives, through `playwright-core`.
 *
 * The repo installs no browser; a suite uses the one Playwright's cache holds
 * for this `playwright-core` version, else the newest chromium in that cache,
 * else `RALPH_TEST_E2E_CHROMIUM`. With none of those it is skipped and says
 * so, rather than failing a host that has never run a browser.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

/** A chromium this host already has, or null. */
export function findChromium(): string | null {
  const override = process.env.RALPH_TEST_E2E_CHROMIUM;
  if (override !== undefined && override !== "") return existsSync(override) ? override : null;
  try {
    const own = chromium.executablePath();
    if (existsSync(own)) return own;
  } catch {
    // No registry entry for this platform: fall through to the cache.
  }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return null;
  const candidates = readdirSync(cache)
    .filter((name) => /^chromium(_headless_shell)?-\d+$/.test(name))
    .sort((left, right) => Number(right.split("-").at(-1)) - Number(left.split("-").at(-1)));
  for (const name of candidates) {
    for (const binary of ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const path = join(cache, name, binary);
      if (existsSync(path)) return path;
    }
  }
  return null;
}
