// @vitest-environment node
/**
 * Code context through the gate (felipearos/ralph#499): a ticket filed for an
 * app with a configured repo queues a case; a poll with no report batch to
 * hand over prepares the oldest one and hands it over as
 * `code context <KEY> (<apps>)`; the next poll validates the session's
 * result and posts it on the ticket (quiet and live) or records it (shadow);
 * a refused result is handed back once and then dropped; a case that cannot
 * be prepared is retried later and never holds a report back.
 *
 * In-process against a fake Slack and a fake Jira at the HTTP seam, with git
 * and ffmpeg faked at `CodeContextDeps` (the real git calls are
 * `clerk/code-context.test.ts`'s). The session is the test: it writes the
 * result the model would have.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CLERK_DEFAULTS, type ClerkMode, type ClerkRules, type CodeContextRules } from "../project-config";
import { CASE_PATTERN, COMMENT_MIN, caseDirOf, showCase, type CaseJson, type Git } from "./code-context";
import { INTAKE_WORKFLOW, SITE, after, fakeJira, fakeSlack, type FakeJira, type FakeSlack, APP_LABELS } from "./fakes";
import { noCache, poll, verdictLine, type PollDeps, type Verdict } from "./gate";
import { jiraClient } from "./jira";
import { REQUIRED_SCOPES, slackClient, tsMs } from "./slack";
import { readClerkStore, withClerkStore } from "./store";

const CHANNEL = "C0TEAMCHAN1";
const T0 = "1760961600.000000";
const at = (minutes: number): number => tsMs(after(T0, minutes));
const SHA = "cb0ae16d2a9e5ef0123456789abcdef012345678";

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A comment the validator takes: the header, then enough of a body. */
const goodComment = (extra = ""): string =>
  [
    `Contexto de código (revisión automática sobre origin/dev ${SHA.slice(0, 7)})`,
    "",
    "Dónde está: `src/app/checklists/export.ts`, en **exportChecklist**.",
    "",
    "Causa probable: el filtro de fechas descarta el último día del rango.",
    "- Línea 42: compara con `<` en vez de `<=`.",
    "- Ya corregido en dev por el commit abc1234, no desplegado.",
    "",
    `Propuesta: desplegar dev. ${extra}`,
  ].join("\n");

interface Rig {
  slack: FakeSlack;
  jira: FakeJira;
  root: string;
  storePath: string;
  plans: Map<string, unknown>;
  gitCalls: string[][];
  /** Make git calls whose args include `on` fail with `why`, until cleared. */
  gitFails: { on: string; why: string } | null;
  frames: string[];
  rules: ClerkRules;
  pollAt(minutes: number, rules?: ClerkRules): Promise<Verdict>;
  store(): ReturnType<typeof readClerkStore>["store"];
  /** Hand the waiting batch over and file each report as a ticket of `app`. */
  fileAll(minutes: number, app?: string): Promise<Verdict>;
  /** What the session writes. */
  writeResult(key: string, value: unknown): void;
}

async function rig(mode: ClerkMode, options: { codeContext?: CodeContextRules | null; scopes?: string[] } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-code-"));
  roots.push(dir);
  const root = join(dir, "worktree");
  mkdirSync(root);
  const clones = { pwa: join(dir, "acme-pwa"), Backoffice: join(dir, "acme-backoffice") };
  mkdirSync(clones.pwa);
  mkdirSync(clones.Backoffice);
  const storePath = join(dir, "clara.json");
  const slack = fakeSlack(CHANNEL, { users: { U0ANA: "Ana Pérez" }, ...(options.scopes === undefined ? {} : { scopes: options.scopes }) });
  const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
  const plans = new Map<string, unknown>();
  const codeContext: CodeContextRules | null =
    options.codeContext === undefined
      ? {
          repos: {
            pwa: { path: clones.pwa, ref: "origin/dev", mainRef: "origin/main" },
            Backoffice: { path: clones.Backoffice, ref: "origin/dev", mainRef: "origin/main" },
          },
        }
      : options.codeContext;
  const rules: ClerkRules = {
    ...CLERK_DEFAULTS,
    appLabels: APP_LABELS,
    mode,
    channel: CHANNEL,
    canvas: null,
    shadowCanvas: null,
    operator: null,
    jira: { site: SITE, project: "OA", intakeProject: "OAI" },
    attachmentMaxMb: 1,
    codeContext,
  };
  const self: Rig = {
    slack,
    jira,
    root,
    storePath,
    plans,
    gitCalls: [],
    gitFails: null,
    frames: [],
    rules,
    async pollAt(minutes, overrides = rules) {
      const git: Git = (args) => {
        self.gitCalls.push([...args]);
        if (self.gitFails !== null && args.includes(self.gitFails.on)) return { ok: false, stdout: "", why: self.gitFails.why };
        return { ok: true, stdout: args.includes("rev-parse") ? SHA : "", why: "" };
      };
      const deps: PollDeps = {
        rules: overrides,
        now: () => at(minutes),
        slack: slackClient("xoxb-fake", slack.fetch, CHANNEL),
        jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch),
        storePath,
        intervalSeconds: 300,
        readPlan: (batch) => plans.get(batch),
        journal: () => {},
        notify: () => {},
        alert: () => {},
        secret: "test-secret",
        stop: () => true,
        codeContext: {
          root,
          git,
          frames: (video, framesDir) => {
            self.frames.push(video);
            mkdirSync(framesDir, { recursive: true });
            writeFileSync(join(framesDir, "001.jpg"), "JPG");
            return [join(framesDir, "001.jpg")];
          },
        },
      };
      return (await poll(deps, noCache())).verdict;
    },
    store: () => readClerkStore(storePath, CHANNEL).store,
    async fileAll(minutes, app = "pwa") {
      await self.pollAt(minutes);
      const batch = self.store().batch!;
      plans.set(batch.id, {
        batch: batch.id,
        entries: batch.reports.map((report, index) => ({
          report: report.id,
          verdict: "issue",
          type: "Error",
          app,
          priority: "Medium",
          assignee: "person",
          difficulty: "medium",
          story_points: 3,
          duplicate_of: null,
          summary_es: `Resumen ${index}`,
          description_es: `Descripción ${index}`,
        })),
      });
      return self.pollAt(minutes + 1);
    },
    writeResult(key, value) {
      writeFileSync(join(caseDirOf(root, key), "result.json"), typeof value === "string" ? value : JSON.stringify(value));
    },
  };
  // The first poll starts the clerk at T0.
  await self.pollAt(0);
  return self;
}

const caseJson = (r: Rig, key: string): CaseJson => JSON.parse(readFileSync(join(caseDirOf(r.root, key), "case.json"), "utf8")) as CaseJson;
const commentPosts = (r: Rig) => r.jira.calls.filter((call) => call.method === "POST" && /\/issue\/[A-Z]+-\d+\/comment$/.test(call.path));
const keyOf = (verdict: Verdict): string => CASE_PATTERN.exec(verdict.why)?.[1] ?? "";

describe("queueing and handing over a case", () => {
  it("hands over a filed ticket's case once no report batch waits, with its repos, files, frames and comments", async () => {
    const r = await rig("quiet");
    const shot = r.slack.file("F0SHOT", { name: "IMG_1.png", content: "PNG-BYTES" });
    const video = r.slack.file("F0VIDEO", { name: "rec.mp4", content: "MP4-BYTES", mimetype: "video/mp4" });
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo exportar el reporte", files: [shot, video] });
    const handed = await r.fileAll(15);
    const key = r.jira.issues.find((issue) => issue.key.startsWith("OAI-"))!.key;
    // The poll that filed the ticket had no other batch: it hands the case at once.
    expect(handed).toMatchObject({ work: true, why: `code context ${key} (pwa)` });
    expect(verdictLine(handed)).toBe(`clerk-gate: work available — code context ${key} (pwa)`);
    expect(CASE_PATTERN.exec(handed.why)?.[1]).toBe(key);
    const json = caseJson(r, key);
    expect(json).toMatchObject({
      key,
      attempt: 1,
      previousProblems: [],
      ticket: { summary: "Resumen 0", app: "pwa", type: "Error", priority: "Medium", permalink: expect.stringContaining("/archives/C0TEAMCHAN1/") },
      repos: [{ app: "pwa", path: join(r.root, ".ralph", "logs", "code", "pwa"), ref: "origin/dev", sha: SHA, mainRef: "origin/main" }],
      result: join(caseDirOf(r.root, key), "result.json"),
    });
    expect(json.ticket.description).toContain("Descripción 0");
    expect(json.ticket.labels).toContain("acme-pwa");
    expect(Array.isArray(json.ticket.comments)).toBe(true);
    const files = join(caseDirOf(r.root, key), "files");
    expect(json.files).toEqual([
      { name: "IMG_1.png", path: join(files, "IMG_1.png"), type: "image/png" },
      { name: "rec.mp4", path: join(files, "rec.mp4"), type: "video/mp4", frames: [join(files, "rec.mp4.frames", "001.jpg")] },
    ]);
    expect(readFileSync(join(files, "IMG_1.png"), "utf8")).toBe("PNG-BYTES");
    // The clone is fetched and its worktree added; its own checkout is never touched.
    expect(r.gitCalls).toContainEqual(["-C", r.rules.codeContext!.repos.pwa!.path, "fetch", "--quiet", "origin"]);
    expect(r.gitCalls).toContainEqual(["-C", r.rules.codeContext!.repos.pwa!.path, "worktree", "add", "--quiet", "--detach", join(r.root, ".ralph", "logs", "code", "pwa"), SHA]);
    expect(r.gitCalls.some((args) => args.includes("checkout") && args.includes(r.rules.codeContext!.repos.pwa!.path))).toBe(false);
    // The session's one window onto it.
    expect(JSON.parse(showCase(r.root, r.storePath, CHANNEL)!)).toEqual(json);
    expect(r.store().codeContext).toMatchObject({ handed: key, cases: { [key]: { state: "handed", apps: ["pwa"] } } });
  });

  it("reads both repos for a ticket of both apps, and queues nothing for one of neither", async () => {
    const r = await rig("quiet");
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "Falla en todos lados" });
    const both = await r.fileAll(15, "both");
    const key = keyOf(both);
    expect(both.why).toBe(`code context ${key} (pwa, Backoffice)`);
    expect(caseJson(r, key).repos.map((repo) => repo.app)).toEqual(["pwa", "Backoffice"]);

    r.slack.post({ ts: after(T0, 30), user: "U0ANA", text: "Una consulta general" });
    await r.fileAll(45, "none");
    expect(Object.keys(r.store().codeContext!.cases)).toEqual([key]);
  });

  it("queues no case for an app without a configured repo", async () => {
    const r = await rig("quiet", { codeContext: { repos: { pwa: { path: "/nonexistent/pwa", ref: "origin/dev", mainRef: "origin/main" } } } });
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No exporta" });
    const verdict = await r.fileAll(15, "Backoffice");
    expect(verdict.work).toBe(false);
    expect(r.store().codeContext).toBeUndefined();
  });

  it("hands a report batch over before a queued case, and the case once the batch is applied", async () => {
    const r = await rig("quiet");
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No exporta" });
    // Filed, and a second report already settled when the case could go.
    r.slack.post({ ts: after(T0, 3), user: "U0BETO", text: "No sincroniza" });
    await r.pollAt(15);
    const first = r.store().batch!;
    expect(first.reports).toHaveLength(2);
    r.plans.set(first.id, {
      batch: first.id,
      entries: first.reports.map((report, index) => ({ report: report.id, verdict: "issue", type: "Error", app: "pwa", priority: "Low", assignee: "person", difficulty: "easy", story_points: 1, duplicate_of: null, summary_es: `R${index}`, description_es: `D${index}` })),
    });
    // A new report settles while the case waits.
    r.slack.post({ ts: after(T0, 10), user: "U0CARLA", text: "Se cae al abrir" });
    const applied = await r.pollAt(25);
    expect(applied.work).toBe(true);
    expect(applied.why).toMatch(/^1 settled report in C0TEAMCHAN1/);
    expect(Object.values(r.store().codeContext!.cases).map((one) => one.state)).toEqual(["queued", "queued"]);
    const batch = r.store().batch!;
    r.plans.set(batch.id, { batch: batch.id, entries: [{ report: batch.reports[0]!.id, verdict: "ignore", ignore_reason: "no es un reporte" }] });
    const next = await r.pollAt(26);
    // The oldest case first.
    const keys = Object.keys(r.store().codeContext!.cases);
    expect(next).toMatchObject({ work: true, why: `code context ${keys[0]} (pwa)` });
  });
});

describe("a case that cannot be prepared", () => {
  it("is a note and a retry on the backoff, never a stop, and never holds a report back", async () => {
    const r = await rig("quiet");
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No exporta" });
    r.gitFails = { on: "fetch", why: "fatal: unable to access origin" };
    const filed = await r.fileAll(15);
    expect(filed.work).toBe(false);
    expect(filed.stop).toBeUndefined();
    expect(filed.notes?.join("\n")).toMatch(/OAI-\d+: code context not prepared \(git fetch in .* failed: fatal: unable to access origin\); tried again in 5m/);
    const [one] = Object.values(r.store().codeContext!.cases);
    expect(one).toMatchObject({ state: "queued", tries: 1 });
    // Within the backoff, nothing is retried.
    const calls = r.gitCalls.length;
    expect((await r.pollAt(18)).work).toBe(false);
    expect(r.gitCalls).toHaveLength(calls);
    // A report still goes over while the case waits.
    r.slack.post({ ts: after(T0, 20), user: "U0BETO", text: "No sincroniza" });
    expect((await r.pollAt(31)).why).toMatch(/^1 settled report/);
    // Once git answers again, the case goes out at the next poll with no batch.
    r.gitFails = null;
    const batch = r.store().batch!;
    r.plans.set(batch.id, { batch: batch.id, entries: [{ report: batch.reports[0]!.id, verdict: "ignore", ignore_reason: "x" }] });
    expect((await r.pollAt(32)).why).toBe(`code context ${one!.key} (pwa)`);
  });

  it("downloads no file without files:read, and still hands the case over", async () => {
    const r = await rig("quiet", { scopes: [...REQUIRED_SCOPES] });
    const shot = r.slack.file("F0SHOT", { name: "IMG_1.png", content: "PNG" });
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No exporta", files: [shot] });
    const handed = await r.fileAll(15);
    expect(handed.work).toBe(true);
    expect(caseJson(r, keyOf(handed)).files).toEqual([{ name: "IMG_1.png", path: null, type: "image/png" }]);
    expect(handed.notes?.join("\n")).toContain("IMG_1.png not downloaded for code context: the Slack token lacks files:read");
  });

  it("is dropped when its ticket is gone", async () => {
    const r = await rig("quiet");
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No exporta" });
    r.jira.fail("/rest/api/3/issue/OAI-", { status: 404 }, { method: "GET", always: true });
    const filed = await r.fileAll(15);
    expect(filed.work).toBe(false);
    expect(Object.values(r.store().codeContext!.cases)[0]).toMatchObject({ state: "dropped" });
  });
});

describe("settling the session's result", () => {
  it("posts a valid result on the ticket as rich text, once", async () => {
    const r = await rig("quiet");
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No exporta" });
    const key = keyOf(await r.fileAll(15));
    r.writeResult(key, { key, comment_es: goodComment() });
    const settled = await r.pollAt(30);
    expect(settled.work).toBe(false);
    expect(settled.notes).toContain(`${key}: code-context comment posted`);
    const [post] = commentPosts(r).filter((call) => call.path.endsWith(`/${key}/comment`));
    const doc = (post!.body as { body: { content: { type: string; content?: { text?: string; marks?: { type: string }[] }[] }[] } }).body;
    expect(doc.content[0]).toEqual({ type: "paragraph", content: [{ type: "text", text: `Contexto de código (revisión automática sobre origin/dev ${SHA.slice(0, 7)})` }] });
    expect(doc.content[1]!.content).toEqual([
      { type: "text", text: "Dónde está:", marks: [{ type: "strong" }] },
      { type: "text", text: " " },
      { type: "text", text: "src/app/checklists/export.ts", marks: [{ type: "code" }] },
      { type: "text", text: ", en " },
      { type: "text", text: "exportChecklist", marks: [{ type: "strong" }] },
      { type: "text", text: "." },
    ]);
    expect(doc.content.map((node) => node.type)).toEqual(["paragraph", "paragraph", "paragraph", "bulletList", "paragraph"]);
    expect(r.store().codeContext!.cases[key]).toMatchObject({ state: "done", comment: goodComment().trim() });
    expect(r.store().codeContext!.handed).toBeNull();
    // Done: never posted again, and no case left to hand over.
    expect((await r.pollAt(45)).work).toBe(false);
    expect(commentPosts(r).filter((call) => call.path.endsWith(`/${key}/comment`))).toHaveLength(1);
  });

  it("retries a post Jira refuses for now, and takes one already on the ticket as posted", async () => {
    const r = await rig("live");
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No exporta" });
    const key = keyOf(await r.fileAll(15));
    r.writeResult(key, { key, comment_es: goodComment() });
    r.jira.fail(`/rest/api/3/issue/${key}/comment`, { status: 503 }, { method: "POST" });
    const failed = await r.pollAt(30);
    expect(failed.notes?.join("\n")).toMatch(new RegExp(`${key}: code-context comment not posted yet \\(.*\\); tried again in 5m`));
    expect(r.store().codeContext!.cases[key]).toMatchObject({ state: "posting", tries: 1 });
    // The post landed after all, but its save did not: the next try finds it.
    r.jira.issues.find((issue) => issue.key === key)!.comments!.push(goodComment());
    const adopted = await r.pollAt(36);
    expect(adopted.notes).toContain(`${key}: code-context comment already on the ticket`);
    expect(r.store().codeContext!.cases[key]!.state).toBe("done");
  });

  it("hands a refused result back once with its problems, then drops the case", async () => {
    const r = await rig("quiet");
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No exporta" });
    const key = keyOf(await r.fileAll(15));
    r.writeResult(key, { key: "OAI-1", comment_es: "Corto 🚀" });
    const again = await r.pollAt(30);
    expect(again).toMatchObject({ work: true, why: `code context ${key} (pwa)` });
    const second = caseJson(r, key);
    expect(second.attempt).toBe(2);
    expect(second.previousProblems).toEqual([
      `'key' must be "${key}"; got "OAI-1"`,
      `'comment_es' must be ${COMMENT_MIN} to 6000 characters; got 8`,
      `the first line of 'comment_es' must start with "Contexto de código"; got "Corto 🚀"`,
      "'comment_es' must carry no emoji; found 🚀",
    ]);
    // The stale result went with the first attempt.
    expect(existsSync(second.result)).toBe(false);
    r.writeResult(key, "{ not json");
    const dropped = await r.pollAt(45);
    expect(dropped.work).toBe(false);
    expect(dropped.notes?.join("\n")).toMatch(new RegExp(`${key}: code context dropped after 2 failed attempts — result.json is not JSON`));
    expect(r.store().codeContext!.cases[key]).toMatchObject({ state: "dropped" });
    expect(commentPosts(r).filter((call) => call.path.endsWith(`/${key}/comment`))).toEqual([]);
  });

  it("hands a case whose session wrote nothing over again, and counts it failed after three", async () => {
    const r = await rig("quiet");
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No exporta" });
    const key = keyOf(await r.fileAll(15));
    expect((await r.pollAt(30)).why).toBe(`code context ${key} (pwa)`);
    expect(caseJson(r, key).attempt).toBe(1);
    expect((await r.pollAt(45)).why).toBe(`code context ${key} (pwa)`);
    // The third hand-over with nothing written is a failed attempt: the second goes out told why.
    expect((await r.pollAt(60)).why).toBe(`code context ${key} (pwa)`);
    expect(caseJson(r, key)).toMatchObject({ attempt: 2, previousProblems: ["no result.json was written after 3 hand-overs"] });
  });
});

describe("modes and the feature off", () => {
  it("shadow queues the would-be ticket's case and records the comment without any Jira write", async () => {
    const r = await rig("shadow");
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No exporta" });
    const handed = await r.fileAll(15);
    const key = keyOf(handed);
    expect(key).toMatch(/^SHADOW-\d+$/);
    expect(caseJson(r, key).ticket.comments).toEqual([]);
    r.writeResult(key, { key, comment_es: goodComment() });
    const settled = await r.pollAt(30);
    expect(settled.notes).toContain(`${key}: code-context comment recorded (shadow: not posted)`);
    expect(r.store().codeContext!.cases[key]).toMatchObject({ state: "done", comment: goodComment().trim() });
    expect(r.jira.writes()).toEqual([]);
  });

  it("is off without clerk.codeContext: nothing queued, nothing handed, no git", async () => {
    const r = await rig("quiet", { codeContext: null });
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No exporta" });
    const verdict = await r.fileAll(15);
    expect(verdict.work).toBe(false);
    expect(r.store().codeContext).toBeUndefined();
    expect(r.gitCalls).toEqual([]);
  });

  it("leaves a handed case alone while the feature is off, and settles it once it is back", async () => {
    const r = await rig("quiet");
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No exporta" });
    const key = keyOf(await r.fileAll(15));
    r.writeResult(key, { key, comment_es: goodComment() });
    await r.pollAt(30, { ...r.rules, codeContext: null });
    expect(r.store().codeContext!.cases[key]!.state).toBe("handed");
    await r.pollAt(31);
    expect(r.store().codeContext!.cases[key]!.state).toBe("done");
  });

  it("drops a case nobody could prepare in two weeks", async () => {
    const r = await rig("quiet");
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No exporta" });
    r.gitFails = { on: "fetch", why: "fatal: no network" };
    await r.fileAll(15);
    const verdict = await r.pollAt(15 * 24 * 60);
    expect(verdict.notes?.join("\n")).toMatch(/code context dropped — never prepared in 14 days \(git fetch .* failed: fatal: no network\)/);
    expect(Object.values(r.store().codeContext!.cases)[0]!.state).toBe("dropped");
  });

  it("keeps the queue when the store moves to another channel", async () => {
    const r = await rig("quiet");
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No exporta" });
    const key = keyOf(await r.fileAll(15));
    const moved = readClerkStore(r.storePath, "C0OTHERCHAN");
    expect(moved.store.codeContext?.cases[key]?.state).toBe("handed");
    await withClerkStore(r.storePath, CHANNEL, () => {});
  });
});
