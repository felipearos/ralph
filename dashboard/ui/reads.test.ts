// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  agentGuideRead,
  agentsRead,
  bridgeStatusRead,
  controlsRead,
  dashboardRead,
  FLOOR_POLL_MS,
  floorFrontierRead,
  floorRead,
  frontierRead,
  fullDashboardRead,
  githubReposRead,
  intakeMetricsRead,
  intakeRead,
  intakeSessionRead,
  javRead,
  labelsRead,
  lineupCatalogRead,
  modelUpdatesRead,
  lineupRead,
  loopControlRead,
  loopHistoryRead,
  loopNotificationsRead,
  loopPanelRead,
  notificationsRead,
  POLL_MS,
  projectSetupRead,
  projectSleepRead,
  projectsHealthRead,
  projectsRead,
  verifierRead,
  sentinelRead,
  rulesOnlyRead,
  sentinelRulesRead,
  setupDefaultsRead,
  settingsRead,
  promptsRead,
  SLOW_POLL_MS,
  streamUrl,
  usageRead,
} from "./reads";

describe("named reads", () => {
  it("scopes the project reads under /api/p/:project", () => {
    expect(dashboardRead("loggd")).toEqual({ url: "/api/p/loggd/loops", intervalMs: POLL_MS });
    expect(streamUrl("loggd")).toBe("/api/p/loggd/stream");
    expect(projectSetupRead("loggd")).toEqual({ url: "/api/p/loggd/setup", intervalMs: POLL_MS });
    expect(usageRead("loggd")).toEqual({ url: "/api/p/loggd/usage", intervalMs: POLL_MS });
    expect(loopControlRead("loggd", "rafa")).toEqual({ url: "/api/p/loggd/loops/rafa/control", intervalMs: POLL_MS });
    expect(sentinelRead("loggd")).toEqual({ url: "/api/p/loggd/sentinel", intervalMs: SLOW_POLL_MS });
    expect(sentinelRead(null)).toEqual({ url: "/api/sentinel", intervalMs: SLOW_POLL_MS });
  });

  it("polls at the shell's five seconds", () => {
    expect(POLL_MS).toBe(5000);
  });

  it("reads the registry unscoped", () => {
    expect(projectsRead()).toEqual({ url: "/api/projects", intervalMs: POLL_MS });
    expect(projectsHealthRead("loggd")).toEqual({ url: "/api/projects/health?selected=loggd", intervalMs: POLL_MS });
  });

  it("encodes a project or loop with a space or a slash", () => {
    expect(dashboardRead("my project").url).toBe("/api/p/my%20project/loops");
    expect(streamUrl("my project")).toBe("/api/p/my%20project/stream");
    expect(projectSetupRead("a/b").url).toBe("/api/p/a%2Fb/setup");
    expect(projectsHealthRead("a/b c").url).toBe("/api/projects/health?selected=a%2Fb%20c");
    expect(loopControlRead("a/b", "my loop").url).toBe("/api/p/a%2Fb/loops/my%20loop/control");
    expect(loopControlRead(null, "x/y").url).toBe("/api/loops/x%2Fy/control");
    expect(bridgeStatusRead("my project", true)?.url).toBe("/api/p/my%20project/bridge");
  });

  it("leaves usage and control unscoped when the shell has no project, as api() does", () => {
    expect(usageRead(null)).toEqual({ url: "/api/usage", intervalMs: POLL_MS });
    expect(loopControlRead(null, "rafa")).toEqual({ url: "/api/loops/rafa/control", intervalMs: POLL_MS });
  });

  it("reads every loop's control view from one batched URL (#615)", () => {
    expect(controlsRead("loggd")).toEqual({ url: "/api/p/loggd/controls", intervalMs: POLL_MS });
    expect(controlsRead("a/b").url).toBe("/api/p/a%2Fb/controls");
    expect(controlsRead(null)).toEqual({ url: "/api/controls", intervalMs: POLL_MS });
  });

  it("reads the project's sleep slowly, and only on the local page", () => {
    expect(projectSleepRead("loggd", false)).toEqual({ url: "/api/p/loggd/sleep", intervalMs: SLOW_POLL_MS });
    expect(projectSleepRead("a/b", false)?.url).toBe("/api/p/a%2Fb/sleep");
    expect(projectSleepRead("loggd", true)).toBeNull();
  });

  it("reads the bridge only on the remote page", () => {
    expect(bridgeStatusRead("loggd", true)).toEqual({ url: "/api/p/loggd/bridge", intervalMs: POLL_MS });
    expect(bridgeStatusRead("loggd", false)).toBeNull();
  });

  it("polls the minute reads at sixty seconds", () => {
    expect(SLOW_POLL_MS).toBe(60_000);
  });

  it("reads the feed and the agents every five seconds, scoped as api() scopes", () => {
    expect(notificationsRead("loggd")).toEqual({ url: "/api/p/loggd/notifications", intervalMs: POLL_MS });
    expect(notificationsRead(null)).toEqual({ url: "/api/notifications", intervalMs: POLL_MS });
    expect(loopNotificationsRead("loggd", "rafa")).toEqual({ url: "/api/p/loggd/loops/rafa/notifications", intervalMs: POLL_MS });
    expect(loopNotificationsRead(null, "rafa")).toEqual({ url: "/api/loops/rafa/notifications", intervalMs: POLL_MS });
    expect(loopHistoryRead("loggd", "rafa")).toEqual({ url: "/api/p/loggd/loops/rafa/history", intervalMs: POLL_MS });
    expect(loopHistoryRead(null, "rafa")).toEqual({ url: "/api/loops/rafa/history", intervalMs: POLL_MS });
    expect(agentsRead("loggd")).toEqual({ url: "/api/p/loggd/agents", intervalMs: POLL_MS });
    expect(agentsRead(null)).toEqual({ url: "/api/agents", intervalMs: POLL_MS });
  });

  it("encodes a loop with a slash or a space in the feed reads", () => {
    expect(loopNotificationsRead("a/b", "my loop").url).toBe("/api/p/a%2Fb/loops/my%20loop/notifications");
    expect(loopNotificationsRead(null, "x/y").url).toBe("/api/loops/x%2Fy/notifications");
    expect(loopHistoryRead("a/b", "my loop").url).toBe("/api/p/a%2Fb/loops/my%20loop/history");
    expect(loopHistoryRead(null, "x/y").url).toBe("/api/loops/x%2Fy/history");
  });

  it("reads the labels every minute", () => {
    expect(labelsRead("loggd")).toEqual({ url: "/api/p/loggd/labels", intervalMs: SLOW_POLL_MS });
    expect(labelsRead(null)).toEqual({ url: "/api/labels", intervalMs: SLOW_POLL_MS });
  });

  it("reads the intake every minute, always under the project", () => {
    expect(intakeRead("acme-intake")).toEqual({ url: "/api/p/acme-intake/intake", intervalMs: SLOW_POLL_MS });
    expect(intakeSessionRead("acme-intake")).toEqual({ url: "/api/p/acme-intake/intake/session", intervalMs: SLOW_POLL_MS });
    expect(intakeMetricsRead("acme-intake", true)).toEqual({ url: "/api/p/acme-intake/intake/metrics", intervalMs: SLOW_POLL_MS });
    expect(intakeRead("my project").url).toBe("/api/p/my%20project/intake");
  });

  it("reads no metrics while the session is closed", () => {
    expect(intakeMetricsRead("acme-intake", false)).toBeNull();
  });

  it("reads the floor on the shell's URL every fifteen seconds", () => {
    expect(FLOOR_POLL_MS).toBe(15_000);
    expect(floorRead("loggd")).toEqual({ url: "/api/p/loggd/loops", intervalMs: FLOOR_POLL_MS });
    expect(floorRead("my project").url).toBe(dashboardRead("my project").url);
  });

  it("reads each full list the overview leaves out on its own URL, polled (#67)", () => {
    expect(loopPanelRead("loggd", "rafa")).toEqual({ url: "/api/p/loggd/loops/rafa", intervalMs: POLL_MS });
    expect(loopPanelRead("a/b", "my loop").url).toBe("/api/p/a%2Fb/loops/my%20loop");
    expect(frontierRead("loggd")).toEqual({ url: "/api/p/loggd/frontier", intervalMs: POLL_MS });
    expect(fullDashboardRead("loggd")).toEqual({ url: "/api/p/loggd/dashboard", intervalMs: POLL_MS });
    expect(fullDashboardRead("my project").url).toBe("/api/p/my%20project/dashboard");
  });

  it("reads the floor's frontiers on the backlog's URL every fifteen seconds", () => {
    expect(floorFrontierRead("loggd")).toEqual({ url: "/api/p/loggd/frontier", intervalMs: FLOOR_POLL_MS });
    expect(floorFrontierRead("my project").url).toBe(frontierRead("my project").url);
  });

  it("reads the one-shot views once, scoped as api() scopes", () => {
    expect(lineupCatalogRead("loggd", false)).toEqual({ url: "/api/p/loggd/lineup/catalog", intervalMs: null });
    expect(lineupCatalogRead("loggd", true)).toEqual({ url: "/api/p/loggd/lineup/catalog?refresh=1", intervalMs: null });
    expect(lineupCatalogRead(null, false)).toEqual({ url: "/api/lineup/catalog", intervalMs: null });
    expect(lineupCatalogRead(null, true)).toEqual({ url: "/api/lineup/catalog?refresh=1", intervalMs: null });
    expect(modelUpdatesRead("loggd")).toEqual({ url: "/api/p/loggd/lineup/updates", intervalMs: null });
    expect(modelUpdatesRead(null)).toEqual({ url: "/api/lineup/updates", intervalMs: null });
    expect(lineupRead("loggd", "rafa")).toEqual({ url: "/api/p/loggd/lineup?loop=rafa", intervalMs: null });
    expect(lineupRead(null, "rafa")).toEqual({ url: "/api/lineup?loop=rafa", intervalMs: null });
    expect(lineupRead("loggd", "rafa", "pr-medic")).toEqual({ url: "/api/p/loggd/lineup?loop=rafa&role=pr-medic", intervalMs: null });
    expect(lineupRead(null, "my loop", "a&b c")).toEqual({ url: "/api/lineup?loop=my%20loop&role=a%26b%20c", intervalMs: null });
    expect(verifierRead("loggd")).toEqual({ url: "/api/p/loggd/agents/verifier", intervalMs: null });
    expect(verifierRead(null)).toEqual({ url: "/api/agents/verifier", intervalMs: null });
    expect(sentinelRulesRead("loggd")).toEqual({ url: "/api/p/loggd/agents/sentinel", intervalMs: null });
    expect(sentinelRulesRead(null)).toEqual({ url: "/api/agents/sentinel", intervalMs: null });
    expect(rulesOnlyRead("loggd", "sentinel")).toEqual({ url: "/api/p/loggd/agents/sentinel?pending=skip", intervalMs: null });
    expect(rulesOnlyRead(null, "verifier")).toEqual({ url: "/api/agents/verifier?pending=skip", intervalMs: null });
    expect(javRead("loggd")).toEqual({ url: "/api/p/loggd/jav", intervalMs: null });
    expect(javRead(null)).toEqual({ url: "/api/jav", intervalMs: null });
    expect(settingsRead("loggd")).toEqual({ url: "/api/p/loggd/settings", intervalMs: null });
    expect(settingsRead(null)).toEqual({ url: "/api/settings", intervalMs: null });
    expect(promptsRead("loggd")).toEqual({ url: "/api/p/loggd/settings/prompts", intervalMs: null });
    expect(promptsRead(null)).toEqual({ url: "/api/settings/prompts", intervalMs: null });
    expect(agentGuideRead("loggd")).toEqual({ url: "/api/p/loggd/agents/guide", intervalMs: null });
    expect(agentGuideRead(null)).toEqual({ url: "/api/agents/guide", intervalMs: null });
    expect(setupDefaultsRead("loggd")).toEqual({ url: "/api/p/loggd/setup/defaults", intervalMs: null });
    expect(setupDefaultsRead(null)).toEqual({ url: "/api/setup/defaults", intervalMs: null });
  });

  it("lists the GitHub repos on the bare path, as add-project reads it", () => {
    expect(githubReposRead()).toEqual({ url: "/api/github/repos", intervalMs: null });
  });
});
