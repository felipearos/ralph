// @vitest-environment node
/**
 * The chat panel in a real browser, against the design preview (#256).
 *
 * `bun dashboard/preview.ts` serves the real React shell over canned loops,
 * and `preview-chat.ts` answers the chat routes with canned turns, so this
 * drives the whole page — Talk on a halted loop's card, a turn and its fake
 * reply, the mode pill, Stop & fix, and Unblock & resume's draft → edit →
 * confirm — without a `claude`, a redactor or a loop.
 *
 * The browser is Playwright's chromium, driven through `playwright-core`
 * (no test runner of its own: vitest runs this like any other suite), found
 * by `e2e-chromium.ts`; with none on the host the suite is skipped.
 *
 * `RALPH_TEST_E2E_SCREENSHOTS=<dir>` saves the panel at desktop width and at 375 px.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";

import { findChromium } from "./e2e-chromium";
import { bunPath } from "./fixtures";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("starts the design preview server and a headless chromium", 90_000);

const CHROMIUM = findChromium();
const SHOTS = process.env.RALPH_TEST_E2E_SCREENSHOTS ?? null;

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

/** A page of the preview's one project, `preview`: `/` lands there by itself. */
async function openPage(width: number, height: number, path = "/"): Promise<Page> {
  const context = await browser!.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`);
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === null) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, name) });
}

describe.skipIf(CHROMIUM === null)("the chat panel against the preview", () => {
  beforeAll(async () => {
    origin = await startPreview();
    browser = await chromium.launch({ executablePath: CHROMIUM!, headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    preview?.kill("SIGTERM");
  });

  it("is usable at 375 px: Talk on the halted card, a turn and its reply, nothing wider than the screen", async () => {
    const page = await openPage(375, 812);
    const talk = page.locator('a[href$="/loops/remo"] [data-talk]');
    await talk.waitFor();
    await talk.click();
    const panel = page.locator("[data-chat-panel]");
    await panel.waitFor();
    // The card's link did not navigate: the click stayed on the button.
    expect(new URL(page.url()).pathname).not.toContain("/loops/");
    await expect.poll(() => panel.locator("[data-chat-source]").innerText()).toMatch(/^Resumed from iteration 2026-10-07 10:50:01 UTC/);

    await panel.getByLabel("Message").fill("why are you blocked?");
    await panel.getByRole("button", { name: "Send" }).click();
    await panel.locator('[data-chat="agent"]', { hasText: "(preview) I stopped because" }).waitFor();
    await panel.locator('[data-chat="seed"]').waitFor();

    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    for (const control of [panel.getByRole("button", { name: "Send" }), panel.getByRole("button", { name: "Unblock & resume" }), panel.getByRole("radio", { name: "Fix" })]) {
      const at = (await control.boundingBox())!;
      expect(at.x).toBeGreaterThanOrEqual(0);
      expect(at.x + at.width).toBeLessThanOrEqual(375);
      expect(at.y + at.height).toBeLessThanOrEqual(812);
    }
    await shot(page, "chat-375.png");
    await page.context().close();
  });

  it("drafts, edits and confirms a handback from a halted loop's card, and shows every step", async () => {
    const page = await openPage(1440, 900);
    await page.locator('a[href$="/loops/remo"] [data-talk]').click();
    const panel = page.locator("[data-chat-panel]");
    await panel.getByLabel("Message").fill("why are you blocked?");
    await panel.getByRole("button", { name: "Send" }).click();
    await panel.locator('[data-chat="agent"]', { hasText: "(preview) I stopped because" }).waitFor();
    // The panel's own width wins over the sheet's side default (max-w-sm),
    // which the radix-sera sheet once applied under a data-[side] variant.
    expect((await panel.boundingBox())!.width).toBeGreaterThan(800);

    // Fix on a stopped loop: confirmed first, then the mode line on the stream.
    await panel.getByRole("radio", { name: "Fix" }).click();
    await panel.getByRole("button", { name: "Switch to Fix" }).click();
    await panel.locator('[data-chat="mode"]', { hasText: "Fix mode" }).waitFor();
    await panel.getByRole("radio", { name: "Ask" }).click();
    await panel.locator('[data-chat="mode"]', { hasText: "Ask mode" }).waitFor();
    await shot(page, "chat-desktop.png");

    await panel.getByRole("button", { name: "Unblock & resume" }).click();
    const summary = panel.getByLabel("Decision summary");
    await expect.poll(() => summary.inputValue()).toMatch(/What was decided: revert the lazy loader/);
    await summary.fill("Operator: revert the lazy loader for posters only, then rerun the gate.");
    await panel.getByRole("button", { name: "Hand back…" }).click();
    await panel.getByRole("button", { name: "Confirm & resume" }).click();
    await panel.getByText("remo resumed").waitFor();
    for (const step of ["worktree", "comment", "label", "journal", "restart"]) {
      await expect.poll(() => panel.locator(`[data-chat-handback] [data-step="${step}"]`).innerText()).toMatch(/done/);
    }
    await shot(page, "chat-desktop-handback.png");
    await page.context().close();
  });

  it("refuses a handback over a dirty worktree and lists the dirty paths", async () => {
    const page = await openPage(1024, 800, "/p/preview/backlog");
    // #1040 wears remo-blocked; remo is running again since the handback above.
    const row = page.locator("li", { hasText: "Import CSV from Letterboxd" });
    await row.locator("[data-talk]").click();
    const panel = page.locator("[data-chat-panel]");
    await expect.poll(() => panel.locator("[data-chat-source]").innerText()).toMatch(/^Fresh session — no resumable session:/);
    await panel.getByRole("button", { name: "Unblock & resume" }).click();
    const summary = panel.getByLabel("Decision summary");
    await expect.poll(() => summary.inputValue()).not.toBe("");
    await summary.fill("Leave it dirty for now.");
    await panel.getByRole("button", { name: "Hand back…" }).click();
    await panel.getByRole("button", { name: "Confirm & resume" }).click();
    await panel.getByText("refused at worktree").waitFor();
    await panel.getByText("src/media/poster-grid.tsx").waitFor();
    await page.context().close();
  });

  it("offers Stop & fix on a running loop's stuck ticket, waits at the boundary, then switches to Fix", async () => {
    const page = await openPage(1024, 800, "/p/preview/backlog");
    // #1109 wears ralph-blocked, and ralph's supervisor is alive.
    await page.locator("li", { hasText: "Episode progress sync" }).locator("[data-talk]").click();
    const panel = page.locator("[data-chat-panel]");
    await expect.poll(() => panel.getByRole("radio", { name: "Fix" }).isDisabled()).toBe(true);
    await panel.getByRole("button", { name: "Stop & fix" }).click();
    await panel.locator("[data-chat-banner]", { hasText: "Stopping — waiting for the iteration boundary" }).waitFor();
    await panel.locator('[data-chat="mode"]', { hasText: "Fix mode" }).waitFor();
    await expect.poll(() => panel.getByRole("radio", { name: "Fix" }).getAttribute("aria-checked")).toBe("true");
    await page.context().close();
  });

  it("deep-links to a loop page, survives a reload, and walks back and forward through the sidebar's pages", async () => {
    const page = await openPage(1440, 900, "/p/preview/loops/rafa");
    // The shell's title bar comes first; a loop page repeats the name in its own header below it.
    const heading = page.locator("h1").first();
    await expect.poll(() => heading.innerText()).toBe("rafa");
    await page.reload();
    await expect.poll(() => heading.innerText()).toBe("rafa");
    expect(new URL(page.url()).pathname).toBe("/p/preview/loops/rafa");

    await page.locator('a[href="/p/preview/notifications"]').first().click();
    await page.waitForURL(/\/p\/preview\/notifications$/);
    await expect.poll(() => heading.innerText()).toBe("Notifications");
    await page.goBack();
    await page.waitForURL(/\/p\/preview\/loops\/rafa$/);
    await expect.poll(() => heading.innerText()).toBe("rafa");
    await page.goForward();
    await page.waitForURL(/\/p\/preview\/notifications$/);
    await expect.poll(() => heading.innerText()).toBe("Notifications");
    await page.context().close();
  });

  it("opens a loop from its card on the Agents page without reloading the page", async () => {
    const page = await openPage(1440, 900, "/p/preview/");
    const card = page.locator("main").locator('a[href="/p/preview/loops/rafa"]').first();
    await card.waitFor();
    // A full reload would drop this: only an in-page navigation keeps it.
    await page.evaluate(() => {
      (window as unknown as { __marker?: string }).__marker = "kept";
    });
    await card.click();
    await page.waitForURL(/\/p\/preview\/loops\/rafa$/);
    await expect.poll(() => page.locator("h1").first().innerText()).toBe("rafa");
    expect(await page.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBe("kept");
    await page.context().close();
  });

  it("opens a loop and a project from the All projects floor without reloading the page", async () => {
    const page = await openPage(1440, 900, "/factory");
    const marker = () => page.evaluate(() => (window as unknown as { __marker?: string }).__marker);
    const loop = page.locator("main").locator('a[href="/p/preview/loops/rafa"]').first();
    await loop.waitFor();
    // A full reload would drop this: only an in-page navigation keeps it.
    await page.evaluate(() => {
      (window as unknown as { __marker?: string }).__marker = "kept";
    });
    await loop.click();
    await page.waitForURL(/\/p\/preview\/loops\/rafa$/);
    await expect.poll(() => page.locator("h1").first().innerText()).toBe("rafa");
    expect(await marker()).toBe("kept");

    await page.goBack();
    await page.waitForURL(/\/factory$/);
    const project = page.locator("main").locator('a[href="/p/widgets"]').first();
    await project.waitFor();
    await project.click();
    await page.waitForURL(/\/p\/widgets\/?$/);
    expect(await marker()).toBe("kept");
    await page.context().close();
  });

  it("moves the scoped floor address up to the unscoped All projects floor", async () => {
    const page = await openPage(1440, 900, "/p/preview/factory");
    // `/p/preview/factory` also ends in /factory, so wait on the whole path.
    await page.waitForURL((url) => url.pathname === "/factory");
    await expect.poll(() => page.locator("h1").first().innerText()).toBe("All projects");
    await page.context().close();
  });

  it("switches project from the rail, shows none of the previous project, and scopes a command to the project on screen", async () => {
    // The previous project's loops, read as the page reads them, so the check follows the preview's roster.
    const previewLoops = ((await (await fetch(`${origin}/api/p/preview/loops`)).json()) as { loops: { loop: string }[] }).loops.map(
      (entry) => entry.loop,
    );
    expect(previewLoops).toContain("rafa");
    expect(previewLoops).not.toContain("wido");

    const page = await openPage(1440, 900, "/p/preview/loops/rafa");
    await expect.poll(() => page.locator("h1").first().innerText()).toBe("rafa");
    await page.getByRole("link", { name: /^widgets\b/ }).click();
    await page.waitForURL(/\/p\/widgets\/$/);
    await page.locator("main").locator('a[href="/p/widgets/loops/wido"]').first().waitFor();
    for (const name of previewLoops) {
      await expect.poll(() => page.getByText(name, { exact: true }).count()).toBe(0);
      expect(await page.locator(`a[href$="/loops/${name}"]`).count()).toBe(0);
    }

    // A command from the sidebar's loop menu goes to the project on screen, not the one the page opened on.
    await page.locator('[data-sidebar="sidebar"] a[href="/p/widgets/loops/wido"]').click({ button: "right" });
    const [sent] = await Promise.all([
      page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/")),
      page.getByRole("menuitem", { name: "Pause", exact: true }).click(),
    ]);
    expect(new URL(sent.url()).pathname).toMatch(/^\/api\/p\/widgets\//);
    await page.context().close();
  });
});

describe.runIf(CHROMIUM === null)("the chat panel against the preview", () => {
  it.skip("needs a chromium: none in Playwright's cache and no RALPH_TEST_E2E_CHROMIUM", () => undefined);
});
