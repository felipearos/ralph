// @vitest-environment node
/**
 * Filing a learning as a ticket, from the page's side: the adapter against a
 * recording executor (what crosses the process boundary, and how each answer
 * the CLI may give is narrowed), then the route's validation. Nothing here
 * spawns: `findings.ts` is the harness's, faked by the executor.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createLearningsFileAdapter, parseLearningsFileOutput } from "./learnings-file-adapter";
import { handleLearningsFileRoute, LEARNINGS_FILE_PATH, parseLearningsFileRequest } from "./learnings-file-routes";
import { createRecordingExecutor } from "./recording-executor";

const HARNESS = "/opt/ralph";
const ROOT = "/home/dev/loggd";
const URL = "https://github.com/felipearos/loggd/issues/2901";
const ok = (body: unknown) => ({ status: 0, stdout: `${JSON.stringify(body)}\n`, stderr: "" });

describe("the learnings-file adapter", () => {
  it("runs one verb for one entry in the project's checkout, publishing into the harness it reads", async () => {
    const recorder = createRecordingExecutor({ fallback: ok({ version: 1, slug: "ssh-key", url: URL }) });
    const adapter = createLearningsFileAdapter({ cliDir: HARNESS, root: ROOT, bunPath: "/bin/bun", exec: recorder.exec });
    expect(await adapter.file("ssh-key", "project")).toEqual({ slug: "ssh-key", url: URL, problem: null });
    const { invocation } = recorder.calls[0]!;
    expect(invocation.command).toBe("/bin/bun");
    expect(invocation.args).toEqual([join(HARNESS, "findings.ts"), "file", "ssh-key", "--scope", "project"]);
    expect(invocation.cwd).toBe(ROOT);
    expect(invocation.env.RALPH_JOURNAL_HOME).toBe(HARNESS);
  });

  it("reads a refusal's last line as the problem, without the CLI's prefix", () => {
    const refused = { status: 1, stdout: "", stderr: "learning revised: …\nfindings: Error: ssh-key: its Fix already reads \"#2818\"\n" };
    expect(parseLearningsFileOutput("ssh-key", refused)).toEqual({ slug: "ssh-key", url: null, problem: 'ssh-key: its Fix already reads "#2818"' });
    expect(parseLearningsFileOutput("ssh-key", { status: null, stdout: "", stderr: "" }).problem).toBe("findings.ts file did not run");
  });

  it("says queued, not filed, when the publish landed without a ticket, and refuses a foreign shape", () => {
    expect(parseLearningsFileOutput("ssh-key", ok({ version: 1, slug: "ssh-key", url: null }))).toEqual({ slug: "ssh-key", url: null, problem: null });
    expect(parseLearningsFileOutput("ssh-key", ok({ version: 1, slug: "other", url: URL })).problem).toMatch(/unexpected shape/);
    expect(parseLearningsFileOutput("ssh-key", { status: 0, stdout: "nope", stderr: "" }).problem).toMatch(/did not print JSON/);
  });
});

describe("the learnings-file route", () => {
  it("takes a slug and a scope, and nothing that is not one", () => {
    expect(parseLearningsFileRequest({ slug: "ssh-key", scope: "harness" })).toEqual({ slug: "ssh-key", scope: "harness" });
    expect(() => parseLearningsFileRequest({ slug: "--scope", scope: "project" })).toThrow(/slug/);
    expect(() => parseLearningsFileRequest({ slug: "ssh-key", scope: "both" })).toThrow(/scope/);
    expect(() => parseLearningsFileRequest([])).toThrow(/JSON object/);
  });

  it("answers POST only, and a bad body as a 400 before the CLI runs", async () => {
    let ran = 0;
    const adapter = { file: async (slug: string) => ((ran += 1), { slug, url: URL, problem: null }) };
    const at = `http://local${LEARNINGS_FILE_PATH}`;
    expect((await handleLearningsFileRoute(new Request(at), LEARNINGS_FILE_PATH, adapter))?.status).toBe(405);
    const bad = new Request(at, { method: "POST", body: JSON.stringify({ slug: "Bad Slug", scope: "project" }) });
    expect((await handleLearningsFileRoute(bad, LEARNINGS_FILE_PATH, adapter))?.status).toBe(400);
    expect(ran).toBe(0);
    const good = new Request(at, { method: "POST", body: JSON.stringify({ slug: "ssh-key", scope: "project" }) });
    expect(await (await handleLearningsFileRoute(good, LEARNINGS_FILE_PATH, adapter))?.json()).toEqual({ slug: "ssh-key", url: URL, problem: null });
    expect(await handleLearningsFileRoute(good, "/api/sleep", adapter)).toBeNull();
  });
});
