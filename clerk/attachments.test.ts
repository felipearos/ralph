// @vitest-environment node
/**
 * A report's files on its Jira ticket: every file a reporter posted is
 * downloaded from Slack with the bot token and uploaded to the ticket under
 * its own name, in live and quiet mode and never in shadow; one over
 * `clerk.attachmentMaxMb` is linked instead; a missing `files:read`, a failed
 * download or a failed upload files the ticket anyway and retries the file
 * later; a rerun attaches nothing twice; a thread reply's files follow its
 * comment; and the backfill attaches the files of reports filed before.
 *
 * In-process through the gate, against a fake Slack and a fake Jira at the
 * HTTP seam, so the downloads and the multipart uploads asserted here are the
 * requests the real clients sent.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CLERK_DEFAULTS, type ClerkMode, type ClerkRules } from "../project-config";
import { RETRY_FIRST_MS, backfill, queueAttachments, reportsOnTicket, retryDelayMs, tsOfPermalink, RETRY_MAX_MS } from "./attachments";
import { batchView } from "./batch";
import { INTAKE_WORKFLOW, SITE, after, fakeJira, fakeSlack, type FakeJira, type FakeSlack, APP_LABELS } from "./fakes";
import { MB, attachedBlock } from "./files";
import { noCache, poll, type PollDeps } from "./gate";
import { jiraClient } from "./jira";
import { readablePath } from "./readable";
import { permalink } from "./reports";
import { FILES_SCOPE, KPI_SCOPES, REQUIRED_SCOPES, slackClient, tsMs } from "./slack";
import { emptyStore, readClerkStore, withClerkStore } from "./store";

const CHANNEL = "C0TEAMCHAN1";
const WORKSPACE_URL = "https://example.slack.com/";
const T0 = "1760961600.000000";
const at = (minutes: number): number => tsMs(after(T0, minutes));

const rulesFor = (mode: ClerkMode, extra: Partial<ClerkRules> = {}): ClerkRules => ({
  ...CLERK_DEFAULTS,
  appLabels: APP_LABELS,
  mode,
  channel: CHANNEL,
  canvas: "F0CHANCANV1",
  shadowCanvas: null,
  operator: null,
  jira: { site: SITE, project: "OA", intakeProject: "OAI" },
  attachmentMaxMb: 1,
  ...extra,
});

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

interface Rig {
  slack: FakeSlack;
  jira: FakeJira;
  storePath: string;
  plans: Map<string, unknown>;
  notes: string[];
  rules: ClerkRules;
  /** The worktree the gate downloads a batch's readable files under, when asked to. */
  dir: string;
  /** One poll at `minutes` after T0; its notes are kept in `notes`. */
  pollAt(minutes: number): Promise<void>;
}

async function rig(mode: ClerkMode, options: { scopes?: string[]; rules?: Partial<ClerkRules>; readable?: boolean } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-attach-"));
  roots.push(dir);
  const storePath = join(dir, "clara.json");
  const slack = fakeSlack(CHANNEL, { users: { U0ANA: "Ana Pérez", U0BETO: "Beto" }, ...(options.scopes === undefined ? {} : { scopes: options.scopes }) });
  const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
  const plans = new Map<string, unknown>();
  const notes: string[] = [];
  const rules = rulesFor(mode, options.rules);
  const deps = (now: number): PollDeps => ({
    rules,
    now: () => now,
    slack: slackClient("xoxb-fake", slack.fetch, CHANNEL),
    jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch),
    storePath,
    intervalSeconds: 300,
    readPlan: (batch) => plans.get(batch) ?? "no plan",
    journal: () => {},
    notify: () => {},
    alert: () => {},
    secret: "test-secret",
    stop: () => true,
    ...(options.readable === true ? { filesRoot: dir } : {}),
  });
  await poll(deps(tsMs(T0)), noCache());
  return {
    dir,
    slack,
    jira,
    storePath,
    plans,
    notes,
    rules,
    async pollAt(minutes) {
      const { verdict } = await poll(deps(at(minutes)), noCache());
      notes.push(...(verdict.notes ?? []));
    },
  };
}

/** Hand the waiting batch over and file every report in it as a new ticket. */
async function fileAll(r: Rig, minutes: number): Promise<void> {
  await r.pollAt(minutes);
  const batch = readClerkStore(r.storePath, CHANNEL).store.batch!;
  r.plans.set(batch.id, {
    batch: batch.id,
    entries: batch.reports.map((report, index) => ({
      report: report.id,
      verdict: "issue",
      type: "Error",
      app: "Backoffice",
      priority: "Medium",
      assignee: "agent",
      difficulty: "medium",
      story_points: 3,
      duplicate_of: null,
      summary_es: `Resumen ${index}`,
      description_es: `Descripción ${index}`,
    })),
  });
  await r.pollAt(minutes + 1);
}

/** A report with a screenshot and a video, and the files Slack hosts for it. */
function postReport(r: Rig) {
  const shot = r.slack.file("F0SHOT", { name: "captura de pantalla.png", content: "PNG-BYTES" });
  const video = r.slack.file("F0VIDEO", { name: "error.mov", content: "MOV-BYTES", mimetype: "video/quicktime" });
  const huge = r.slack.file("F0HUGE", { name: "grabación larga.mp4", content: "x", mimetype: "video/mp4", size: 5 * MB });
  r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo exportar el reporte", files: [shot, video] });
  // A second message within the join window: the same report.
  r.slack.post({ ts: after(T0, 2), user: "U0ANA", text: "y la grabación", files: [huge] });
  return { shot, video, huge };
}

const ticket = (r: Rig) => r.jira.issues.find((issue) => issue.key.startsWith("OAI-"));
const uploads = (r: Rig) => r.jira.calls.filter((call) => call.method === "POST" && call.path.endsWith("/attachments"));
const downloads = (r: Rig) => r.slack.calls.filter((call) => call.method === "files.download");
const attachmentsOf = (r: Rig) => (ticket(r)?.attachments ?? []).map((file) => [file.filename, file.content, file.mimeType]);
const recordsOf = (r: Rig) => readClerkStore(r.storePath, CHANNEL).store.attachments ?? {};
const flat = (text: string): string => text.replace(/\n/g, "");

describe("a report's files on its ticket", () => {
  it("live: uploads each file under its own name, names it in the description, and links the one too large", async () => {
    const r = await rig("live");
    const { shot, video, huge } = postReport(r);
    await fileAll(r, 20);

    const issue = ticket(r)!;
    expect(attachmentsOf(r)).toEqual([
      ["captura de pantalla.png", "PNG-BYTES", "image/png"],
      ["error.mov", "MOV-BYTES", "video/quicktime"],
    ]);
    // Downloaded with the bot token, the large one never asked for.
    expect(downloads(r).map((call) => call.params.file)).toEqual(["F0SHOT", "F0VIDEO"]);
    // The description names the attachments rather than linking them, keeps
    // the report's own permalink, and links the file too large to attach.
    const description = flat(issue.description!);
    expect(description).toContain("Adjuntos en el ticket:");
    expect(description).toContain("captura de pantalla.png");
    expect(description).toContain("error.mov");
    expect(description).not.toContain(shot.permalink!);
    expect(description).not.toContain(video.permalink!);
    expect(description).toContain(`grabación larga.mp4: demasiado grande para adjuntar (5 MB; el límite es 1 MB), en Slack: ${huge.permalink}`);
    expect(description).toContain(`Reportado por Ana Pérez en Slack: ${permalink(WORKSPACE_URL, CHANNEL, after(T0, 1))}`);
    expect(description).not.toContain("Capturas:");
    expect(Object.fromEntries(Object.entries(recordsOf(r)[issue.key]!).map(([id, record]) => [id, record.state]))).toEqual({
      F0SHOT: "uploaded",
      F0VIDEO: "uploaded",
      F0HUGE: "too-large",
    });
    expect(r.notes).toContain(`${issue.key}: attached captura de pantalla.png`);
  });

  it("quiet: uploads to Jira too, downloads from Slack, and posts nothing in Slack", async () => {
    const r = await rig("quiet");
    postReport(r);
    await fileAll(r, 20);
    expect(attachmentsOf(r).map(([name]) => name)).toEqual(["captura de pantalla.png", "error.mov"]);
    expect(r.slack.calls.filter((call) => call.method === "chat.postMessage")).toEqual([]);
  });

  it("shadow: downloads and uploads nothing, and records what it would attach", async () => {
    const r = await rig("shadow");
    postReport(r);
    await fileAll(r, 20);
    expect(downloads(r)).toEqual([]);
    expect(uploads(r)).toEqual([]);
    const records = recordsOf(r);
    const [key] = Object.keys(records);
    expect(key).toMatch(/^SHADOW-/);
    expect(Object.fromEntries(Object.entries(records[key!]!).map(([id, record]) => [id, [record.name, record.state]]))).toEqual({
      F0SHOT: ["captura de pantalla.png", "shadow"],
      F0VIDEO: ["error.mov", "shadow"],
      F0HUGE: ["grabación larga.mp4", "too-large"],
    });
  });

  it("without files:read files the ticket, asks Slack for no file, says so, and attaches once the scope is added", async () => {
    const r = await rig("live", { scopes: [...REQUIRED_SCOPES, ...KPI_SCOPES] });
    postReport(r);
    await fileAll(r, 20);
    expect(ticket(r)).toBeDefined();
    expect(downloads(r)).toEqual([]);
    expect(uploads(r)).toEqual([]);
    expect(r.notes.some((note) => note.includes("the Slack token lacks files:read") && note.includes("2 report files not attached"))).toBe(true);
    // The backoff: the next poll does not ask again.
    r.notes.length = 0;
    await r.pollAt(22);
    expect(r.notes.some((note) => note.includes("files:read"))).toBe(false);
    // The operator adds the scope; after the backoff the files go up.
    r.slack.scopes.push(FILES_SCOPE);
    await r.pollAt(21 + RETRY_FIRST_MS / 60_000 + 1);
    expect(attachmentsOf(r).map(([name]) => name)).toEqual(["captura de pantalla.png", "error.mov"]);
  });

  it("a sign-in page from Slack is a failure to retry, never an attachment", async () => {
    const r = await rig("live");
    postReport(r);
    r.slack.fail("files.download", { error: "sign-in" });
    await fileAll(r, 20);
    expect(attachmentsOf(r).map(([name]) => name)).toEqual(["error.mov"]);
    expect(r.notes.some((note) => note.includes("captura de pantalla.png not attached yet") && note.includes("sign-in page"))).toBe(true);
  });

  it("a failed download, then a failed upload, file the ticket anyway and are retried later, each file once", async () => {
    const r = await rig("live");
    postReport(r);
    r.slack.fail("files.download", { status: 503 });
    await fileAll(r, 20);
    const key = ticket(r)!.key;
    expect(attachmentsOf(r).map(([name]) => name)).toEqual(["error.mov"]);
    expect(r.notes.some((note) => note.startsWith(`${key}: captura de pantalla.png not attached yet`))).toBe(true);
    const record = recordsOf(r)[key]!.F0SHOT!;
    expect([record.state, record.tries]).toEqual(["pending", 1]);

    // Not before its backoff.
    await r.pollAt(23);
    expect(downloads(r)).toHaveLength(2);
    // Then the upload fails once.
    r.jira.fail(`/rest/api/3/issue/${key}/attachments`, { status: 502 }, { method: "POST" });
    await r.pollAt(21 + RETRY_FIRST_MS / 60_000 + 1);
    expect(attachmentsOf(r).map(([name]) => name)).toEqual(["error.mov"]);
    expect(recordsOf(r)[key]!.F0SHOT!.tries).toBe(2);
    // And goes up after the doubled wait.
    await r.pollAt(21 + (RETRY_FIRST_MS * 3) / 60_000 + 2);
    expect(attachmentsOf(r).map(([name]) => name)).toEqual(["error.mov", "captura de pantalla.png"]);
    expect(recordsOf(r)[key]!.F0SHOT!.state).toBe("uploaded");
    expect(retryDelayMs(1)).toBe(RETRY_FIRST_MS);
    expect(retryDelayMs(50)).toBe(RETRY_MAX_MS);
  });

  it("never attaches twice: a rerun queues nothing new, and a file whose save was lost is found on the ticket", async () => {
    const r = await rig("live");
    postReport(r);
    await fileAll(r, 20);
    const key = ticket(r)!.key;
    expect(uploads(r)).toHaveLength(2);
    await r.pollAt(40);
    expect(uploads(r)).toHaveLength(2);
    // A kill between an upload and its save: the store still says pending.
    await withClerkStore(r.storePath, CHANNEL, (store) => {
      const record = store.attachments![key]!.F0SHOT!;
      record.state = "pending";
      delete record.doneAt;
    });
    await r.pollAt(41);
    expect(uploads(r)).toHaveLength(2);
    expect(downloads(r)).toHaveLength(2);
    expect(recordsOf(r)[key]!.F0SHOT!.state).toBe("uploaded");
    expect(r.notes).toContain(`${key}: attached captura de pantalla.png (already on the ticket)`);
    // Queued again by hand, nothing is added: the record is the ticket's.
    const store = emptyStore(CHANNEL);
    store.attachments = recordsOf(r);
    expect(queueAttachments(store, key, [{ id: "F0SHOT", name: "x", size: 1, url: "u", permalink: "" }], { mode: "live", maxBytes: MB, report: "r", at: "t" })).toBe(0);
  });

  it("a file of the same name but another size is not taken for one already there", async () => {
    const r = await rig("live");
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "dos capturas", files: [r.slack.file("F0A", { name: "image.png", content: "AAAA" }), r.slack.file("F0B", { name: "image.png", content: "BBBBBB" })] });
    await fileAll(r, 20);
    expect(attachmentsOf(r).map(([name, content]) => [name, content])).toEqual([
      ["image.png", "AAAA"],
      ["image.png", "BBBBBB"],
    ]);
  });

  it("a thread reply's files go onto the ticket beside the comment that copies it", async () => {
    const r = await rig("live");
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "No puedo exportar el reporte" });
    await fileAll(r, 20);
    const key = ticket(r)!.key;
    expect(uploads(r)).toEqual([]);
    const later = r.slack.file("F0LATER", { name: "otra captura.jpg", content: "JPG", mimetype: "image/jpeg" });
    r.slack.post({ ts: after(T0, 30), thread_ts: after(T0, 1), user: "U0BETO", text: "aquí otra captura", files: [later] });
    await r.pollAt(31);
    const comment = ticket(r)!.comments!.find((text) => text.startsWith("Respuesta de Beto"))!;
    expect(flat(comment)).toContain("Adjuntos en el ticket:");
    expect(comment).toContain("otra captura.jpg");
    expect(comment).not.toContain(later.permalink!);
    expect(attachmentsOf(r)).toEqual([["otra captura.jpg", "JPG", "image/jpeg"]]);
    expect(recordsOf(r)[key]!.F0LATER!.state).toBe("uploaded");
    // The next poll copies and attaches nothing again.
    await r.pollAt(32);
    expect(uploads(r)).toHaveLength(1);
  });
});

describe("the backfill", () => {
  it("attaches the files of reports the clerk filed before, and a second run attaches nothing", async () => {
    const r = await rig("live");
    const root = after(T0, 1);
    const dup = after(T0, 5);
    r.slack.post({ ts: root, user: "U0ANA", text: "No puedo exportar", files: [r.slack.file("F0OLD", { name: "vieja.png", content: "OLD" })] });
    r.slack.post({ ts: after(T0, 2), thread_ts: root, user: "U0BETO", text: "a mí también", files: [r.slack.file("F0REPLY", { name: "respuesta.pdf", content: "PDF", mimetype: "application/pdf" })] });
    r.slack.post({ ts: dup, user: "U0BETO", text: "lo mismo", files: [r.slack.file("F0DUP", { name: "dup.png", content: "DUP" })] });
    // Filed before files were attached: links only, as the old clerk wrote it.
    r.jira.add({
      key: "OAI-50",
      summary: "No exporta",
      labels: ["slack-intake"],
      description: `Algo\n\nReportado por Ana Pérez en Slack: ${permalink(WORKSPACE_URL, CHANNEL, root)}\n\nCapturas:\n- https://example.slack.com/files/x`,
      comments: [`Nuevo reporte del mismo problema por Beto en Slack: ${permalink(WORKSPACE_URL, CHANNEL, dup)}\n\n> lo mismo`],
    });
    // Not the clerk's: left alone.
    r.jira.add({ key: "OAI-51", summary: "A mano", labels: [], description: `Reportado por X en Slack: ${permalink(WORKSPACE_URL, CHANNEL, dup)}` });
    const deps = {
      rules: r.rules,
      storePath: r.storePath,
      now: () => at(60),
      slack: slackClient("xoxb-fake", r.slack.fetch, CHANNEL),
      jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, r.jira.fetch),
    };
    const first = await backfill(deps);
    expect([first.tickets, first.queued, first.failed]).toEqual([1, 3, 0]);
    expect(r.jira.issues.find((issue) => issue.key === "OAI-50")!.attachments!.map((file) => file.filename)).toEqual(["vieja.png", "respuesta.pdf", "dup.png"]);
    expect(r.jira.issues.find((issue) => issue.key === "OAI-51")!.attachments).toBeUndefined();
    const second = await backfill(deps);
    expect([second.queued, second.failed]).toEqual([0, 0]);
    expect(uploads(r)).toHaveLength(3);
    // With the store lost, the ticket's own attachments keep it from attaching twice.
    await withClerkStore(r.storePath, CHANNEL, (store) => {
      delete store.attachments;
    });
    const third = await backfill(deps);
    expect(third.queued).toBe(3);
    expect(uploads(r)).toHaveLength(3);
  });

  it("in shadow, records what it would attach and attaches nothing", async () => {
    const r = await rig("shadow");
    const root = after(T0, 1);
    r.slack.post({ ts: root, user: "U0ANA", text: "x", files: [r.slack.file("F0OLD", { name: "vieja.png", content: "OLD" })] });
    r.jira.add({ key: "OAI-50", summary: "x", labels: ["slack-intake"], description: `Reportado por Ana en Slack: ${permalink(WORKSPACE_URL, CHANNEL, root)}` });
    const result = await backfill({
      rules: r.rules,
      storePath: r.storePath,
      now: () => at(60),
      slack: slackClient("xoxb-fake", r.slack.fetch, CHANNEL),
      jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, r.jira.fetch),
    });
    expect(result.queued).toBe(1);
    expect(uploads(r)).toEqual([]);
    expect(recordsOf(r)["OAI-50"]!.F0OLD!.state).toBe("shadow");
  });

  it("reads a ticket's reports from the clerk's own lines alone", () => {
    const link = permalink(WORKSPACE_URL, CHANNEL, "1760961660.000100");
    expect(tsOfPermalink(link, CHANNEL)).toBe("1760961660.000100");
    expect(tsOfPermalink(link, "C0OTHER")).toBeNull();
    expect(reportsOnTicket(`> pegué https://example.slack.com/archives/${CHANNEL}/p1760961000000100\n\nReportado por Ana en Slack: ${link}`, [], CHANNEL)).toEqual([
      "1760961660.000100",
    ]);
  });
});

describe("the lines a file leaves", () => {
  it("names an attached file, and gives one too large its size and its link", () => {
    expect(attachedBlock([], MB)).toEqual([]);
    expect(
      attachedBlock(
        [
          { id: "F1", name: "a.png", size: 10, url: "u", permalink: "https://s/f1" },
          { id: "F2", name: "b.mov", size: 250 * MB, url: "u", permalink: "https://s/f2" },
        ],
        100 * MB,
      ),
    ).toEqual(["Adjuntos en el ticket:\n- a.png\n- b.mov: demasiado grande para adjuntar (250 MB; el límite es 100 MB), en Slack: https://s/f2"]);
  });
});

describe("a report that lives in a PDF (OAI-29)", () => {
  it("hands the session the PDF to read, and files each problem it lists as its own ticket, each with the PDF", async () => {
    const r = await rig("live", { readable: true });
    const pdf = r.slack.file("F0PDF", { name: "Bugs-O2-V01.pdf", content: "%PDF-1.3 cuatro bugs", mimetype: "application/pdf" });
    r.slack.post({ ts: after(T0, 1), user: "U0ANA", text: "Pille 4 cosas", files: [pdf] });
    await r.pollAt(20);
    const batch = readClerkStore(r.storePath, CHANNEL).store.batch!;
    // The session's view lists the local copy beside the message.
    const view = batchView(batch, r.dir) as { reports: { messages: { readable?: string[] }[] }[] };
    const [copy] = view.reports[0]!.messages[0]!.readable!;
    expect(copy).toBe(readablePath(batch.id, { id: "F0PDF", name: "Bugs-O2-V01.pdf" }));
    expect(readFileSync(join(r.dir, copy!), "utf8")).toBe("%PDF-1.3 cuatro bugs");

    const part = (summary: string) => ({ type: "Error", app: "pwa", priority: "Low", assignee: "agent", difficulty: "easy", story_points: 2, summary_es: summary, description_es: `${summary}.` });
    r.plans.set(batch.id, {
      batch: batch.id,
      entries: [
        {
          report: batch.reports[0]!.id,
          verdict: "issue",
          ...part("La navegación se bloquea hasta que cargan los gráficos"),
          duplicate_of: null,
          additional_issues: [part("Fechas vacías en Tareas"), part("La barra de estado tapa Preferencias")],
        },
      ],
    });
    await r.pollAt(21);
    const filed = r.jira.issues.filter((issue) => issue.key.startsWith("OAI-"));
    expect(filed.map((issue) => issue.summary)).toEqual([
      "La navegación se bloquea hasta que cargan los gráficos",
      "Fechas vacías en Tareas",
      "La barra de estado tapa Preferencias",
    ]);
    expect(filed.map((issue) => (issue.attachments ?? []).map((file) => file.filename))).toEqual([["Bugs-O2-V01.pdf"], ["Bugs-O2-V01.pdf"], ["Bugs-O2-V01.pdf"]]);
    expect(flat(filed[2]!.description!)).toContain("Parte 3 de 3 del reporte");
    // The store keeps the confirmer's baseline for every ticket, and the report's own key.
    const store = readClerkStore(r.storePath, CHANNEL).store;
    expect(Object.keys(store.determinations ?? {}).sort()).toEqual(filed.map((issue) => issue.key).sort());
    expect(Object.values(store.processed)[0]!.key).toBe(filed[0]!.key);
  });
});
