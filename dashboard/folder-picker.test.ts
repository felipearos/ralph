// @vitest-environment node
/**
 * The Add project dialog's Browse button, at the HTTP seam: which folder
 * dialog the server opens, and what the page is told back. A browser page
 * cannot learn a folder's absolute path, so the host's own dialog picks it.
 */
import { describe, expect, it } from "vitest";

import type { ExecResult, Invocation } from "./control-adapter";
import { createOnboarding } from "./onboarding";
import { createOnboardingAdapter } from "./onboarding-adapter";
import { handleProjectsRoute, PICK_FOLDER_PATH } from "./onboarding-routes";
import type { ProjectRegistry } from "./projects";

const REGISTRY = { file: "/dev/null", readOnly: false, list: () => [], add: () => ({}), remove: () => false } as unknown as ProjectRegistry;

/** A host whose folder dialog answers `result`, recording every call. */
function host(platform: NodeJS.Platform, result: ExecResult | Error) {
  const calls: Invocation[] = [];
  const exec = async (invocation: Invocation): Promise<ExecResult> => {
    calls.push(invocation);
    if (result instanceof Error) throw result;
    return result;
  };
  const adapter = createOnboardingAdapter({ cliDir: "/harness", home: "/home/op", bunPath: "/usr/bin/bun", env: {}, platform, exec });
  const onboarding = createOnboarding({ adapter, registry: REGISTRY });
  const pick = async (method = "POST") => {
    const response = await handleProjectsRoute(new Request(`http://127.0.0.1${PICK_FOLDER_PATH}`, { method }), PICK_FOLDER_PATH, onboarding);
    return { status: response!.status, body: (await response!.json().catch(() => null)) as Record<string, unknown> | null };
  };
  return { calls, pick };
}

const chose = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "" });

describe("the folder picker", () => {
  it("opens zenity's folder dialog at home on Linux and answers the folder chosen", async () => {
    const { calls, pick } = host("linux", chose("/home/op/Projects/widget\n"));
    expect(await pick()).toEqual({ status: 200, body: { path: "/home/op/Projects/widget" } });
    expect(calls.map(({ command, args, cwd }) => ({ command, args, cwd }))).toEqual([
      {
        command: "zenity",
        args: ["--file-selection", "--directory", "--title=Choose a project checkout", "--filename=/home/op/"],
        cwd: "/home/op",
      },
    ]);
  });

  it("opens osascript's choose folder on macOS, without the trailing slash it prints", async () => {
    const { calls, pick } = host("darwin", chose("/Users/op/widget/\n"));
    expect(await pick()).toEqual({ status: 200, body: { path: "/Users/op/widget" } });
    expect(calls[0]!.command).toBe("osascript");
    expect(calls[0]!.args[1]).toContain('default location POSIX file "/home/op"');
  });

  it("answers null when the dialog is closed without a choice", async () => {
    const { pick } = host("linux", { status: 1, stdout: "", stderr: "" });
    expect(await pick()).toEqual({ status: 200, body: { path: null } });
  });

  it("is 501 when the dialog's program is not installed, or the platform has none", async () => {
    const missing = await host("linux", { status: null, stdout: "", stderr: "spawn zenity ENOENT" }).pick();
    expect(missing.status).toBe(501);
    expect(missing.body).toMatchObject({ error: "NoFolderPicker" });
    const windows = host("win32", chose("C:\\\\x"));
    expect((await windows.pick()).status).toBe(501);
    expect(windows.calls).toEqual([]);
  });

  it("is 501, not 500, when running the dialog's program throws", async () => {
    const thrown = await host("linux", new Error("spawn zenity ENOENT")).pick();
    expect(thrown.status).toBe(501);
    expect(thrown.body).toMatchObject({ error: "NoFolderPicker", message: "zenity could not be run; type the path" });
  });

  it("is 502 with the dialog's own words when it fails otherwise", async () => {
    const { pick } = host("linux", { status: 255, stdout: "", stderr: "cannot open display\n" });
    expect(await pick()).toEqual({ status: 502, body: { error: "FolderPickerFailed", message: "zenity: cannot open display" } });
  });

  it("refuses GET: opening a window is not a read", async () => {
    const { calls, pick } = host("linux", chose("/x\n"));
    expect((await pick("GET")).status).toBe(405);
    expect(calls).toEqual([]);
  });
});
