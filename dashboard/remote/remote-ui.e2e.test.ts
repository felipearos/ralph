// @vitest-environment node
/**
 * The remote dashboard's page in a real browser (#174, spec #165 §8 and §13
 * "UI").
 *
 * `bun dashboard/remote/preview.ts` serves the unchanged shell, flagged
 * remote, through the real remote handler over a store holding the design
 * preview's loops as the collector pushed them. Its `/__remote-preview/…`
 * hooks set the bridge row, age the snapshots and slow the relay, so each
 * banner state, the stale stamp, the control lock, a queued answer and the
 * local-only affordances are driven as the page would meet them.
 *
 * Chromium comes from `e2e-chromium.ts`; with none on the host the suite is
 * skipped. `RALPH_TEST_E2E_SCREENSHOTS=<dir>` saves the banner states.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";

import type { JavView, ProjectPromptsView, ProjectSettingsView } from "../contracts";
import { SNAPSHOT_SCHEMA } from "../contracts";
import { findChromium } from "../e2e-chromium";
import { bunPath } from "../fixtures";
import { subprocessSuite } from "../../test-timeouts";

subprocessSuite("starts the remote preview (a design preview, PGlite and the remote handler) and a headless chromium", 90_000);

const CHROMIUM = findChromium();
const SHOTS = process.env.RALPH_TEST_E2E_SCREENSHOTS ?? null;
const LOCAL_ONLY = "Local dashboard only";
const KILL_SWITCH = "remote control is disabled on the machine";

let preview: ChildProcess | null = null;
let origin = "";
let browser: Browser | null = null;

/** Start the remote preview on a free port, with a short command wait, and read the address it printed. */
async function startPreview(): Promise<string> {
  const child = spawn(bunPath(), [join(import.meta.dirname, "preview.ts")], {
    env: { ...process.env, RALPH_REMOTE_PREVIEW_PORT: "0", RALPH_PREVIEW_HOST: "127.0.0.1", RALPH_REMOTE_PREVIEW_WAIT_MS: "1000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  preview = child;
  return await new Promise<string>((resolve, reject) => {
    let said = "";
    const timer = setTimeout(() => reject(new Error(`the remote preview did not start in 80s:\n${said}`)), 80_000);
    const read = (chunk: Buffer): void => {
      said += chunk.toString();
      const found = /remote preview on (http:\/\/[^\s]+)/.exec(said);
      if (found !== null) {
        clearTimeout(timer);
        resolve(found[1]!);
      }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the remote preview exited (${String(code)}):\n${said}`));
    });
  });
}

async function drive(hook: string, body: unknown): Promise<void> {
  const response = await fetch(`${origin}/__remote-preview/${hook}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
}

async function openPage(path: string, width = 1280, height = 900): Promise<Page> {
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

const banner = (page: Page) => page.locator("[data-bridge-banner]");

describe.skipIf(CHROMIUM === null)("the remote dashboard's page over a pushed snapshot", () => {
  beforeAll(async () => {
    origin = await startPreview();
    browser = await chromium.launch({ executablePath: CHROMIUM!, headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    preview?.kill("SIGTERM");
  });

  beforeEach(async () => {
    await drive("bridge", {});
    await drive("relay", { delayMs: 0 });
    await drive("age", { seconds: 0 });
  });

  it("renders the overview and a loop page from the store, flagged remote", async () => {
    const page = await openPage("/");
    await page.waitForURL(/\/p\/preview\/$/);
    expect(await page.locator('meta[name="ralph-remote"]').getAttribute("content")).toBe("1");
    await page.locator('a[href$="/loops/rafa"]').first().waitFor();
    await banner(page).getByText(/^Live, machine seen \d+ s ago$/).waitFor();
    await shot(page, "remote-overview.png");

    await page.goto(`${origin}/p/preview/loops/rafa`);
    await page.getByRole("heading", { name: "rafa" }).first().waitFor();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    // Live output is not relayed: the pane says so instead of streaming.
    await page.getByText("Live output is not relayed to the remote dashboard").waitFor();
    await page.context().close();
  });

  it("deep-links to a loop page, survives a reload, and comes back to it from Notifications", async () => {
    const page = await openPage("/p/preview/loops/rafa");
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
    await page.context().close();
  });

  it("switches project from the rail and shows none of the previous project's loops", async () => {
    // The design preview behind this page serves a second project, `widgets`,
    // whose one loop `wido` no `preview` loop shares; the bridge pushes both.
    const page = await openPage("/p/preview/loops/rafa");
    await expect.poll(() => page.locator("h1").first().innerText()).toBe("rafa");
    await page.getByRole("link", { name: /^widgets\b/ }).click();
    await page.waitForURL(/\/p\/widgets\/$/);
    await page.locator("main").locator('a[href="/p/widgets/loops/wido"]').first().waitFor();
    for (const name of ["rafa", "remo"]) {
      expect(await page.locator(`a[href$="/loops/${name}"]`).count()).toBe(0);
      expect(await page.getByText(name, { exact: true }).count()).toBe(0);
    }
    await page.context().close();
  });

  it("shows each banner state for the bridge row behind it", async () => {
    const page = await openPage("/p/preview/");
    const states: Array<[string, Record<string, unknown>, RegExp, string]> = [
      ["hot", {}, /^Live, machine seen \d+ s ago$/, "good"],
      ["idle", { hot: false }, /^Connected\. Refreshing from the machine; showing its state as of \d\d:\d\d( [AP]M)?\.$/, "info"],
      ["poll-only", { wake: "poll-only" }, /^Commands may take up to 30 s$/, "warn"],
      ["offline", { live: false, seenSecondsAgo: 300 }, /^Machine offline since \d\d:\d\d( [AP]M)?\. Everything below is the last known state\.$/, "bad"],
      ["dashboard-down", { local: "dashboard-down" }, /^Machine up, local dashboard down$/, "bad"],
      ["schema", { schema: SNAPSHOT_SCHEMA - 1 }, new RegExp(`^The machine runs an older ralph \\(schema ${SNAPSHOT_SCHEMA - 1}, app ${SNAPSHOT_SCHEMA}\\); deploy ~/ralph$`), "warn"],
    ];
    for (const [name, row, text, tone] of states) {
      await drive("bridge", row);
      await page.reload();
      const line = banner(page).getByText(text);
      await line.waitFor();
      expect(await line.getAttribute("data-tone"), name).toBe(tone);
      await shot(page, `remote-banner-${name}.png`);
    }
    await page.context().close();
  });

  it("stamps the feed with the snapshot's push time, and calls it stale past a minute", async () => {
    const page = await openPage("/p/preview/");
    const stamp = page.locator("header").getByText(/^Updated /);
    const pushedAt = async (): Promise<string> =>
      page.evaluate(async () => {
        const response = await fetch("/api/p/preview/loops", { cache: "no-store" });
        return new Date(response.headers.get("x-ralph-snapshot-at")!).toLocaleTimeString();
      });
    await stamp.waitFor();
    expect(await stamp.innerText()).toBe(`Updated ${await pushedAt()}`);
    expect(await stamp.getAttribute("data-stale")).toBeNull();

    await drive("age", { seconds: 120 });
    await page.reload();
    await page.locator("header [data-stale]").waitFor();
    expect(await stamp.innerText()).toBe(`Updated ${await pushedAt()} · stale`);
    await shot(page, "remote-stale.png");
    await page.context().close();
  });

  it("turns every control and Mark read off, with the reason on hover, while controls are disabled", async () => {
    await drive("bridge", { controls: "disabled" });
    const page = await openPage("/p/preview/loops/rafa");
    await banner(page).getByText(`Controls off: ${KILL_SWITCH}`).waitFor();
    for (const name of ["Pause", "Restart", "Stop", "Stop now"]) {
      const button = page.getByRole("button", { name, exact: true });
      await expect.poll(() => button.isDisabled(), { message: name }).toBe(true);
      expect(await button.getAttribute("title"), name).toBe(KILL_SWITCH);
    }
    expect(await page.getByLabel("Where Pause and Stop apply").isDisabled()).toBe(true);

    await page.goto(`${origin}/p/preview/notifications`);
    const markRead = page.getByRole("button", { name: "Mark read" }).first();
    await markRead.waitFor();
    expect(await markRead.isDisabled()).toBe(true);
    expect(await markRead.getAttribute("title")).toBe(KILL_SWITCH);
    await page.context().close();
  });

  it("says a slow command was sent to the machine, then shows the machine's answer", async () => {
    // The handler waits 1 s; the stand-in bridge holds the command for 3.
    await drive("relay", { delayMs: 3000 });
    const page = await openPage("/p/preview/loops/rafa");
    const pause = page.getByRole("button", { name: "Pause", exact: true });
    await expect.poll(() => pause.isEnabled()).toBe(true);
    await pause.click();
    await page.getByText("Sent to the machine, waiting for it to apply…").waitFor();
    await shot(page, "remote-relay-queued.png");
    await page.getByText("pause applied (preview: nothing was sent)").waitFor({ timeout: 15_000 });
    expect(await page.getByText("Sent to the machine, waiting for it to apply…").count()).toBe(0);
    await page.context().close();
  });

  it("shows every local-only affordance disabled, saying so, with its read still on screen", async () => {
    // The Settings overview is a relayed snapshot; its gates list draws on the
    // remote page while Run, which executes on the host, stays local-only (#690).
    const overview: ProjectSettingsView = {
      project: "preview",
      checkout: { path: "/home/dev/ralph", addedAt: null },
      worktreesDir: "/home/dev/worktrees",
      worktreesDefault: true,
      defaultWorktreesDir: "/home/dev/worktrees",
      config: {
        repo: "felipearos/ralph",
        owner: "felipearosr",
        baseBranch: "main",
        displayName: "Preview",
        gates: [
          { name: "test", command: "bun run test" },
          { name: "lint", command: "bun run lint" },
        ],
        requiredChecks: ["buildkite/preview"],
        refuseFiles: [".env"],
        worktreeSetup: [],
      },
      problems: [],
      worktrees: [],
      worktreesProblem: null,
    };
    await drive("snapshot", { key: "settings", value: overview });
    // The Prompts section (#695) is relayed too, and read-only, so it draws there whole.
    const prompts: ProjectPromptsView = {
      fragments: [{ kind: "prompt", path: ".ralph/preview-prompt.md", text: "# Preview prompt", missing: false, problem: null }],
      renders: [{ role: "coder", loop: "rafa", prompt: "You are rafa", error: null }],
      problems: [],
    };
    await drive("snapshot", { key: "prompts", value: prompts });
    const page = await openPage("/p/preview/");
    // Add agent, on the agents page.
    const addAgent = page.getByRole("button", { name: "Add agent" });
    await addAgent.waitFor();
    expect(await addAgent.isDisabled()).toBe(true);
    expect(await page.getByText(LOCAL_ONLY).count()).toBeGreaterThanOrEqual(1);

    // Remove project, on the project's settings page at the sidebar's foot.
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Remove project…" }).waitFor();
    expect(await page.getByRole("button", { name: "Remove project…" }).isDisabled()).toBe(true);
    expect(await page.getByText(LOCAL_ONLY).count()).toBeGreaterThanOrEqual(1);
    // Clean up worktrees, in the same Danger zone: it prunes registrations, so it stays local.
    expect(await page.getByRole("button", { name: "Clean up worktrees…" }).isDisabled()).toBe(true);

    // The gates and required checks, relayed; each gate's Run disabled as local-only.
    await page.getByRole("heading", { name: "Gates" }).waitFor();
    await page.getByText("bun run lint").waitFor();
    // A list item: the edit form's textarea holds the same text.
    await page.getByRole("listitem").filter({ hasText: "buildkite/preview" }).waitFor();
    for (const gate of ["test", "lint"]) {
      const run = page.getByRole("button", { name: `Run ${gate}`, exact: true });
      expect(await run.isDisabled()).toBe(true);
      expect(await run.getAttribute("title")).toBe(LOCAL_ONLY);
    }
    // The refused files draw beside the required checks; the edit form (#692)
    // proposes a config PR from the host, so it is disabled whole.
    await page.getByRole("listitem").filter({ hasText: ".env" }).waitFor();
    for (const name of ["Save gates", "Add gate", "Remove gate test", "Remove gate lint"]) {
      const button = page.getByRole("button", { name, exact: true });
      expect(await button.isDisabled(), name).toBe(true);
      expect(await button.getAttribute("title"), name).toBe(LOCAL_ONLY);
    }
    expect(await page.getByLabel("Gate 1 command").isDisabled()).toBe(true);
    expect(await page.getByLabel("Required checks").isDisabled()).toBe(true);
    expect(await page.getByLabel("Refused files").isDisabled()).toBe(true);
    await page.getByRole("heading", { name: "Prompts" }).waitFor();
    await page.getByText(".ralph/preview-prompt.md").waitFor();
    await page.getByRole("tab", { name: "coder (as rafa)" }).waitFor();

    // Add project, the last tile of the project rail.
    const addProject = page.getByRole("button", { name: /Add project/ });
    await addProject.waitFor();
    expect(await addProject.isDisabled()).toBe(true);
    expect(await addProject.getAttribute("aria-label")).toContain(LOCAL_ONLY);

    // The Jav Save, with the routing it read.
    const jav: JavView = {
      path: "/home/dev/ralph/jav.json",
      exists: true,
      project: "preview",
      own: true,
      config: { enabled: true, labels: ["hard", "easy"], routes: { hard: ["ralph"], easy: ["rafa"] } },
      problems: [],
      loops: ["rafa", "ralph", "remo"],
      reserved: [],
    };
    await drive("snapshot", { key: "jav", value: jav });
    await page.getByRole("button", { name: "Routing" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("hard").first().waitFor();
    expect(await dialog.getByRole("button", { name: "Save routing" }).isDisabled()).toBe(true);
    await dialog.getByText(LOCAL_ONLY).waitFor();
    await page.keyboard.press("Escape");

    // The lineup Save and the Fix panel, on a loop page.
    await page.goto(`${origin}/p/preview/loops/rafa`);
    const fix = page.locator("[data-remote-fix]");
    await fix.waitFor();
    expect(await fix.getByRole("button", { name: "Re-check" }).isDisabled()).toBe(true);
    expect(await fix.getByRole("button", { name: "Fix all" }).isDisabled()).toBe(true);
    await fix.getByText(LOCAL_ONLY).waitFor();
    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog");
    // The stage table renders once the lineup read lands, so the editor is on screen and not still loading.
    await settings.getByRole("group", { name: "Stages" }).waitFor();
    expect(await settings.getByRole("button", { name: "Save lineup" }).isDisabled()).toBe(true);
    await settings.getByText(LOCAL_ONLY).waitFor();
    await shot(page, "remote-lineup.png");
    await page.keyboard.press("Escape");

    // Delete agent, on a stopped loop's page, where only the remote page holds it back.
    await page.goto(`${origin}/p/preview/loops/remo`);
    const deleteAgent = page.getByRole("button", { name: "Delete agent worktree…" });
    await deleteAgent.waitFor();
    expect(await deleteAgent.isDisabled()).toBe(true);

    // The setup form's submit, on a project that is not set up yet.
    await drive("snapshot", { key: "setup", value: { project: "preview", status: "needs-setup", baseBranch: "main", pr: null } });
    await page.goto(`${origin}/p/preview/`);
    const submit = page.getByRole("button", { name: "Open setup PR" });
    await submit.waitFor();
    expect(await submit.isDisabled()).toBe(true);
    await page.getByText(LOCAL_ONLY).first().waitFor();
    await drive("snapshot", { key: "setup", value: { project: "preview", status: "ready", baseBranch: "main", pr: null } });
    await page.context().close();
  });
});
