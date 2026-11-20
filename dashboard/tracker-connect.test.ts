// @vitest-environment node
/**
 * The dashboard's Tracker connector (felipearos/ralph#338), at the HTTP seam:
 * what `tracker.ts` is asked, with what on its stdin, and what the page is
 * told back. The token must reach `tracker.ts` on stdin and nowhere else: not
 * argv, not a response, not an error message.
 */
import { describe, expect, it } from "vitest";

import type { ExecResult, Invocation } from "./control-adapter";
import type { ProjectView } from "./contracts";
import { createOnboarding } from "./onboarding";
import { createOnboardingAdapter } from "./onboarding-adapter";
import { handleSetupRoute } from "./onboarding-routes";
import type { ProjectRegistry } from "./projects";

const TOKEN = "lin_api_SECRET_do_not_echo";
const PROJECT: ProjectView = { id: "acme-backoffice", path: "/work/acme-backoffice", addedAt: "2026-10-20T00:00:00Z", source: "local" };
const REGISTRY = { file: "/dev/null", readOnly: false, list: () => [], add: () => ({}), remove: () => false } as unknown as ProjectRegistry;

/** A `tracker.ts` that answers each connect command from `answers`, recording every call. */
function connector(answers: { test?: object | string; save?: object | string } = {}) {
  const calls: Invocation[] = [];
  const exec = async (invocation: Invocation): Promise<ExecResult> => {
    calls.push(invocation);
    const command = invocation.args[1];
    const answer = command === "connect-test" ? answers.test : answers.save;
    const fallback = command === "connect-test" ? { ok: true, kind: "linear", user: "faros", workspace: "exampleorg", options: [{ key: "AND", name: "Example" }] } : { ok: true, path: "/cfg/x.json" };
    const body = answer ?? fallback;
    return typeof body === "string" ? { status: 1, stdout: "", stderr: body } : { status: (body as { ok?: boolean }).ok ? 0 : 1, stdout: `${JSON.stringify(body)}\n`, stderr: "" };
  };
  const adapter = createOnboardingAdapter({ cliDir: "/harness", bunPath: "/usr/bin/bun", env: {}, exec });
  const onboarding = createOnboarding({ adapter, registry: REGISTRY });
  const post = async (path: string, body: unknown) => {
    const response = await handleSetupRoute(
      new Request(`http://127.0.0.1/api/p/${PROJECT.id}${path}`, { method: "POST", body: JSON.stringify(body) }),
      path,
      PROJECT,
      onboarding,
    );
    return { status: response!.status, text: await response!.text() };
  };
  return { calls, post };
}

describe("the Tracker connector", () => {
  it("tests a token through tracker.ts connect-test, the request on stdin", async () => {
    const { calls, post } = connector({
      test: { ok: true, kind: "linear", user: "faros", workspace: "exampleorg", options: [{ key: "AND", name: "Example" }], states: ["Todo", "In Progress", "Done"] },
    });
    const response = await post("/api/setup/tracker/test", { kind: "linear", apiKey: TOKEN, team: "AND" });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ ok: true, workspace: "exampleorg", states: ["Todo", "In Progress", "Done"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "/usr/bin/bun", args: ["/harness/tracker.ts", "connect-test"], cwd: "/harness" });
    expect(JSON.parse(calls[0]!.input!)).toEqual({ kind: "linear", apiKey: TOKEN, team: "AND" });
    expect(calls[0]!.args.join(" ")).not.toContain(TOKEN);
    expect(response.text).not.toContain(TOKEN);
  });

  it("passes the tracker's refusal through as the report, with no token in it", async () => {
    const { post } = connector({ test: { ok: false, reason: "refused", message: "Linear refused the API key" } });
    const response = await post("/api/setup/tracker/test", { kind: "linear", apiKey: TOKEN });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({ ok: false, reason: "refused", message: "Linear refused the API key" });
  });

  it("refuses a request missing what the tracker needs, before running anything", async () => {
    const { calls, post } = connector();
    const response = await post("/api/setup/tracker/test", { kind: "jira", site: "acme.atlassian.net", email: "a@b.c" });
    expect(response.status).toBe(422);
    expect(JSON.parse(response.text)).toMatchObject({ error: "InvalidTracker" });
    expect(calls).toEqual([]);
  });

  it("refuses the local tracker on both routes, before running anything (#527)", async () => {
    const { calls, post } = connector();
    for (const path of ["/api/setup/tracker/test", "/api/setup/tracker/save"]) {
      const response = await post(path, { kind: "local", key: "SBX", file: "/tmp/tickets.json" });
      expect(response.status).toBe(422);
      expect(JSON.parse(response.text)).toMatchObject({ error: "InvalidTracker" });
    }
    expect(calls).toEqual([]);
  });

  it("saves only after the tracker accepts the token again, under the project's id", async () => {
    const { calls, post } = connector();
    const response = await post("/api/setup/tracker/save", { kind: "linear", apiKey: TOKEN, team: "AND" });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({ saved: true });
    expect(calls.map((call) => call.args.slice(1))).toEqual([["connect-test"], ["connect-save", "--project", "acme-backoffice"]]);
    // Only the credential is stored: not the team, which belongs in the config.
    expect(JSON.parse(calls[1]!.input!)).toEqual({ kind: "linear", apiKey: TOKEN });
    expect(response.text).not.toContain(TOKEN);
  });

  it("saves nothing when the token fails its test", async () => {
    const { calls, post } = connector({ test: { ok: false, reason: "refused", message: "Jira refused the credential for acme.atlassian.net" } });
    const response = await post("/api/setup/tracker/save", { kind: "jira", site: "acme.atlassian.net", email: "a@b.c", apiToken: TOKEN, project: "OA" });
    expect(response.status).toBe(422);
    expect(JSON.parse(response.text)).toMatchObject({ error: "TrackerRefused", message: "Jira refused the credential for acme.atlassian.net" });
    expect(calls.map((call) => call.args[1])).toEqual(["connect-test"]);
  });

  it("reports a tracker.ts that answered nothing parseable as unavailable", async () => {
    const { post } = connector({ test: "tracker: cannot find module" });
    const response = await post("/api/setup/tracker/test", { kind: "linear", apiKey: TOKEN });
    expect(response.status).toBe(502);
    expect(JSON.parse(response.text)).toMatchObject({ error: "TrackerUnavailable" });
    expect(response.text).not.toContain(TOKEN);
  });

  it("answers only POST", async () => {
    const { calls } = connector();
    const adapter = createOnboardingAdapter({ cliDir: "/harness", bunPath: "/usr/bin/bun", env: {}, exec: async () => ({ status: 0, stdout: "", stderr: "" }) });
    const onboarding = createOnboarding({ adapter, registry: REGISTRY });
    const response = await handleSetupRoute(new Request("http://127.0.0.1/x", { method: "GET" }), "/api/setup/tracker/test", PROJECT, onboarding);
    expect(response!.status).toBe(405);
    expect(calls).toEqual([]);
  });
});
