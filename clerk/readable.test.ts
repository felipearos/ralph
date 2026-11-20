// @vitest-environment node
/**
 * A batch's PDFs and images, downloaded for the clerk session to read
 * (OAI-29: "Pille 4 cosas" and four bugs in a PDF the session never saw).
 * Against a fake Slack download and a temporary worktree: nothing here may
 * hold a batch up, and only the batch being handed keeps its files.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { batchView } from "./batch";
import type { AttachableFile } from "./files";
import type { BatchReport } from "./plan";
import { fetchReadable, isReadable, READABLE_DIR, READABLE_MAX_BYTES, READABLE_PER_BATCH, readablePath } from "./readable";
import { SlackError, type Downloaded } from "./slack";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const worktree = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-readable-"));
  scratch.push(dir);
  return dir;
};

const file = (id: string, name: string, extra: Partial<AttachableFile> = {}): AttachableFile => ({
  id,
  name,
  size: 1000,
  url: `https://files.slack.com/files-pri/T0/${id}/${name}`,
  permalink: `https://example.slack.com/files/U0/${id}/${name}`,
  ...extra,
});
const PDF = file("F0PDF", "Bugs O2 V01.pdf", { type: "application/pdf" });
const PNG = file("F0PNG", "captura.png", { type: "image/png" });
const VIDEO = file("F0MOV", "grabacion.mov", { type: "video/quicktime" });

const report = (id: string, attachments: AttachableFile[]): BatchReport => ({
  id,
  author: "U0TOMAS",
  authorName: "Tomás",
  names: { U0TOMAS: "Tomás" },
  roots: [id],
  messages: [{ ts: id, user: "U0TOMAS", text: "Pille 4 cosas", files: attachments.map((one) => one.permalink), attachments, reply: false, permalink: `https://x/p${id}` }],
  lastActivity: id,
  permalink: `https://x/p${id}`,
  candidates: [],
});

/** A Slack download that writes each file's id, or fails or is too large as told. */
function slack(behaviour: Record<string, "fail" | "too-large"> = {}) {
  const asked: string[] = [];
  return {
    asked,
    downloadFile: async (url: string, dest: string): Promise<Downloaded> => {
      asked.push(url);
      const what = Object.entries(behaviour).find(([id]) => url.includes(`/${id}/`))?.[1];
      if (what === "fail") {
        writeFileSync(dest, "half");
        throw new SlackError({ kind: "transient", why: "Slack answered a sign-in page instead of the file" });
      }
      if (what === "too-large") return { kind: "too-large", bytes: READABLE_MAX_BYTES + 1 };
      writeFileSync(dest, url);
      return { kind: "saved", bytes: url.length };
    },
  };
}

describe("which files the session reads", () => {
  it("is a PDF or an image, by its media type or else its name", () => {
    expect([PDF, PNG, VIDEO].map(isReadable)).toEqual([true, true, false]);
    expect(isReadable({ name: "reporte.PDF" })).toBe(true);
    expect(isReadable({ name: "notas.txt" })).toBe(false);
  });

  it("keeps each file under the batch, by its Slack id and a name safe on disk", () => {
    expect(readablePath("batch-1.000100", PDF)).toBe(`${READABLE_DIR}/batch-1.000100/F0PDF-Bugs_O2_V01.pdf`);
    expect(readablePath("b", file("F/../1", "../../etc/passwd"))).toBe(`${READABLE_DIR}/b/F1-_.._etc_passwd`);
  });
});

describe("fetching a batch's files", () => {
  it("downloads its PDFs and images, lists them beside their message, and skips the rest", async () => {
    const root = worktree();
    const fake = slack();
    const reports = [report("1.000100", [PDF, VIDEO]), report("2.000100", [PNG])];
    expect(await fetchReadable(fake, root, "batch-1.000100", reports)).toEqual([]);
    expect(fake.asked).toEqual([PDF.url, PNG.url]);
    expect(readFileSync(join(root, readablePath("batch-1.000100", PDF)), "utf8")).toBe(PDF.url);
    const view = batchView({ id: "batch-1.000100", handedAt: "", attempt: 1, reports }, root) as { reports: { messages: { readable?: string[] }[] }[] };
    expect(view.reports.map((one) => one.messages[0]!.readable)).toEqual([[readablePath("batch-1.000100", PDF)], [readablePath("batch-1.000100", PNG)]]);
    // Without a root, as before: no local copies at all.
    const bare = batchView({ id: "batch-1.000100", handedAt: "", attempt: 1, reports }) as { reports: { messages: object[] }[] };
    expect(bare.reports[0]!.messages[0]).not.toHaveProperty("readable");
  });

  it("downloads nothing twice when the batch is handed again, and drops every other batch's files", async () => {
    const root = worktree();
    mkdirSync(join(root, READABLE_DIR, "batch-0.000100"), { recursive: true });
    const reports = [report("1.000100", [PDF])];
    await fetchReadable(slack(), root, "batch-1.000100", reports);
    const again = slack();
    expect(await fetchReadable(again, root, "batch-1.000100", reports)).toEqual([]);
    expect(again.asked).toEqual([]);
    expect(existsSync(join(root, READABLE_DIR, "batch-0.000100"))).toBe(false);
  });

  it("notes a failed, a too-large and an over-the-cap file, leaves no partial file, and never throws", async () => {
    const root = worktree();
    const big = file("F0BIG", "enorme.pdf", { type: "application/pdf", size: READABLE_MAX_BYTES + 1 });
    const notes = await fetchReadable(slack({ F0PDF: "fail", F0PNG: "too-large" }), root, "batch-1.000100", [report("1.000100", [PDF, PNG, big])]);
    expect(notes).toEqual([
      expect.stringContaining("Bugs O2 V01.pdf could not be downloaded for the session (Slack answered a sign-in page"),
      expect.stringContaining("captura.png is too large to hand to the session"),
      expect.stringContaining("enorme.pdf is too large to hand to the session"),
    ]);
    expect(existsSync(join(root, `${readablePath("batch-1.000100", PDF)}.part`))).toBe(false);
    expect(existsSync(join(root, readablePath("batch-1.000100", PDF)))).toBe(false);
  });

  it(`hands at most ${READABLE_PER_BATCH} files, and says so`, async () => {
    const root = worktree();
    const many = Array.from({ length: READABLE_PER_BATCH + 2 }, (_, n) => file(`F${n}`, `c${n}.png`, { type: "image/png" }));
    const fake = slack();
    const notes = await fetchReadable(fake, root, "batch-1.000100", [report("1.000100", many)]);
    expect(fake.asked).toHaveLength(READABLE_PER_BATCH);
    expect(notes).toEqual([expect.stringContaining(`the session is handed the first ${READABLE_PER_BATCH}`)]);
  });

  it("turns a worktree it cannot write into a note", async () => {
    const root = worktree();
    writeFileSync(join(root, ".ralph"), "a file where the directory goes");
    const notes = await fetchReadable(slack(), root, "batch-1.000100", [report("1.000100", [PDF])]);
    expect(notes).toEqual([expect.stringContaining("could not be prepared for the session")]);
  });
});
