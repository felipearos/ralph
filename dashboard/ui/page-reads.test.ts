import { describe, expect, it } from "vitest";

import { pageReads } from "./page-reads";
import {
  agentsRead,
  bridgeStatusRead,
  controlsRead,
  dashboardRead,
  frontierRead,
  fullDashboardRead,
  intakeRead,
  labelsRead,
  loopHistoryRead,
  loopNotificationsRead,
  loopPanelRead,
  notificationsRead,
  projectSetupRead,
  projectSleepRead,
  projectsHealthRead,
  projectsRead,
  promptsRead,
  sentinelRead,
  settingsRead,
  usageRead,
} from "./reads";
import type { Screen } from "./route-tree";

const P = "loggd";
const CHROME_LOCAL = ["/api/p/loggd/loops", "/api/p/loggd/setup", "/api/projects/health?selected=loggd", "/api/p/loggd/sleep", "/api/projects", "/api/p/loggd/controls"];
const CHROME_REMOTE = ["/api/p/loggd/loops", "/api/p/loggd/setup", "/api/projects/health?selected=loggd", "/api/p/loggd/bridge", "/api/projects", "/api/p/loggd/controls"];

// Each project screen's body reads, on top of the chrome (literal URLs, so a renamed route shows here);
// a third entry is what the remote page reads instead.
const BODY: [Screen, string[], string[]?][] = [
  [{ page: "agents" }, ["/api/p/loggd/agents", "/api/p/loggd/sentinel"]],
  [
    { page: "loop", name: "rafa" },
    ["/api/p/loggd/usage", "/api/p/loggd/loops/rafa/notifications", "/api/p/loggd/loops/rafa/history", "/api/p/loggd/loops/rafa"],
  ],
  [{ page: "notifications" }, ["/api/p/loggd/notifications"]],
  [{ page: "usage" }, ["/api/p/loggd/usage"]],
  // The remote does not relay labels; its page draws "local only".
  [{ page: "labels" }, ["/api/p/loggd/labels"], []],
  // The full lists the overview leaves out (#67).
  [{ page: "backlog" }, ["/api/p/loggd/frontier"]],
  [{ page: "ci" }, ["/api/p/loggd/dashboard"]],
  [{ page: "learnings" }, ["/api/p/loggd/dashboard"]],
  [{ page: "ownership" }, []],
  [{ page: "reconciliation" }, []],
  [{ page: "settings" }, ["/api/p/loggd/settings", "/api/p/loggd/settings/prompts"]],
  [{ page: "states" }, []],
];

const urls = (screen: Screen, project: string | null, remote: boolean): string[] =>
  pageReads(screen, project, remote).map((target) => target.url);

describe("pageReads", () => {
  for (const remote of [false, true]) {
    const chrome = remote ? CHROME_REMOTE : CHROME_LOCAL;
    for (const [screen, local, remoteBody] of BODY) {
      it(`${JSON.stringify(screen)} ${remote ? "remote" : "local"}: the chrome's reads plus the page's`, () => {
        expect(urls(screen, P, remote)).toEqual([...chrome, ...(remote ? (remoteBody ?? local) : local)]);
      });
    }
    it(`factory and landing read the projects list only (${remote ? "remote" : "local"})`, () => {
      expect(urls({ page: "factory" }, null, remote)).toEqual(["/api/projects"]);
      expect(urls({ page: "landing" }, P, remote)).toEqual(["/api/projects"]);
    });
    it(`intake reads its own view, without the chrome (${remote ? "remote" : "local"})`, () => {
      expect(urls({ page: "intake" }, P, remote)).toEqual(["/api/p/loggd/intake"]);
    });
  }

  it("a project page with no project names nothing", () => {
    for (const [screen] of BODY) expect(urls(screen, null, false)).toEqual([]);
    expect(urls({ page: "intake" }, null, false)).toEqual([]);
  });

  it("every URL is the one its hook's factory builds, with no duplicate", () => {
    const factories = new Set(
      [
        dashboardRead(P),
        projectSetupRead(P),
        projectsHealthRead(P),
        bridgeStatusRead(P, true),
        projectSleepRead(P, false),
        projectsRead(),
        controlsRead(P),
        settingsRead(P),
        promptsRead(P),
        agentsRead(P),
        sentinelRead(P),
        usageRead(P),
        loopNotificationsRead(P, "rafa"),
        loopHistoryRead(P, "rafa"),
        loopPanelRead(P, "rafa"),
        frontierRead(P),
        fullDashboardRead(P),
        notificationsRead(P),
        labelsRead(P),
        intakeRead(P),
      ].map((target) => target?.url),
    );
    const screens: Screen[] = [...BODY.map(([screen]) => screen), { page: "factory" }, { page: "landing" }, { page: "intake" }];
    for (const remote of [false, true]) {
      for (const screen of screens) {
        const list = urls(screen, P, remote);
        expect(new Set(list).size).toBe(list.length);
        for (const url of list) {
          expect(factories.has(url), url).toBe(true);
        }
      }
    }
  });
});
