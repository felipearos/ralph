// @vitest-environment node
/**
 * A cold load reads each of the page's polled URLs once, not twice (#68).
 *
 * Opening `/` (which lands on `/p/preview/`) reads six polled URLs:
 * `/api/projects`, and the project's `loops`, `controls`, `agents`, `setup`
 * and `sleep`. The route loader prefetches them; a panel that mounts later
 * (the loop cards, once /loops lands) subscribed to a read that had just
 * settled and read it again, so /controls went out twice ~1.6s apart.
 *
 * The design preview answers at once, which hides that: nothing mounts late.
 * So every /api read is delayed through `page.route` the way a real adapter
 * is slow (/loops 1500ms, /controls 900ms, the rest 300ms). `/stream` is an
 * SSE stream and is never delayed or counted.
 *
 * The check is a floor, never an exact time (AGENTS.md, house rule 4): every
 * request after a URL's first starts at least 4000ms after the first one's
 * response finished — the 5s poll, with slack for a loaded host. A duplicate
 * cold-load read lands within milliseconds and fails it.
 *
 * The browser is Playwright's chromium, found by `e2e-chromium.ts`; with none
 * on the host the suite is skipped.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";

import { findChromium } from "./e2e-chromium";
import { bunPath } from "./fixtures";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("starts the design preview server and a headless chromium", 90_000);

const CHROMIUM = findChromium();

/** The six polled reads of #68. */
const READS = [
  "/api/projects",
  "/api/p/preview/loops",
  "/api/p/preview/controls",
  "/api/p/preview/agents",
  "/api/p/preview/setup",
  "/api/p/preview/sleep",
];

/** How long the injected latency holds each /api read, by pathname. */
function delayOf(pathname: string): number {
  if (pathname === "/api/p/preview/loops") return 1500;
  if (pathname === "/api/p/preview/controls") return 900;
  return 300;
}

/** The poll is 5s; a later read of one URL must start no sooner than this after the first settled. */
const MIN_GAP_MS = 4000;

let preview: ChildProcess | null = null;
let origin = "";
let browser: Browser | null = null;

/** Start the preview on a free port and read the port it printed. */
async function startPreview(): Promise<string> {
  const child = spawn(bunPath(), [join(import.meta.dirname, "preview.ts")], {
    env: { ...process.env, RALPH_PREVIEW_PORT: "0", RALPH_PREVIEW_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  preview = child;
  return await new Promise<string>((resolve, reject) => {
    let said = "";
    const timer = setTimeout(() => reject(new Error(`the preview did not start in 60s:\n${said}`)), 60_000);
    const read = (chunk: Buffer): void => {
      said += chunk.toString();
      const found = /preview on (http:\/\/[^\s]+)/.exec(said);
      if (found !== null) {
        clearTimeout(timer);
        resolve(found[1]!);
      }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the preview exited (${String(code)}):\n${said}`));
    });
  });
}

const isStream = (pathname: string): boolean => pathname.endsWith("/stream");

describe.skipIf(CHROMIUM === null)("a cold load against a slow preview", () => {
  beforeAll(async () => {
    origin = await startPreview();
    browser = await chromium.launch({ executablePath: CHROMIUM!, headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    preview?.kill("SIGTERM");
  });

  it("reads each polled URL once, then only on its poll", async () => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();

    await page.route("**/api/**", async (route) => {
      const { pathname } = new URL(route.request().url());
      if (isStream(pathname)) {
        await route.continue();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayOf(pathname)));
      await route.continue().catch(() => {});
    });

    // Per pathname+search: each request's start, and each response's end, in order.
    const started = new Map<string, number[]>();
    const finished = new Map<string, number[]>();
    const keyOf = (url: string): string | null => {
      const parsed = new URL(url);
      if (!parsed.pathname.startsWith("/api/") || isStream(parsed.pathname)) return null;
      return parsed.pathname + parsed.search;
    };
    page.on("request", (request) => {
      const key = keyOf(request.url());
      if (key !== null) started.set(key, [...(started.get(key) ?? []), Date.now()]);
    });
    page.on("requestfinished", (request) => {
      const key = keyOf(request.url());
      if (key !== null) finished.set(key, [...(finished.get(key) ?? []), Date.now()]);
    });

    await page.goto(`${origin}/`);

    // The 5s poll of /projects and /setup has come round: the first interval is over.
    await expect
      .poll(() => Math.min(started.get("/api/projects")?.length ?? 0, started.get("/api/p/preview/setup")?.length ?? 0), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(2);

    expect(new URL(page.url()).pathname).toBe("/p/preview/");

    for (const url of READS) {
      const starts = started.get(url) ?? [];
      expect(starts.length, `${url} was never requested`).toBeGreaterThanOrEqual(1);
      const firstEnd = finished.get(url)?.[0];
      expect(firstEnd, `${url}: its first response never finished`).toBeDefined();
      for (const at of starts.slice(1)) {
        expect(at - firstEnd!, `${url} was requested again ${at - firstEnd!}ms after its first read settled`).toBeGreaterThanOrEqual(MIN_GAP_MS);
      }
    }
    await context.close();
  });
});
