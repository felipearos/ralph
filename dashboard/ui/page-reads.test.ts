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

const P = "acme-widgets";
const CHROME_LOCAL = ["/api/p/acme-widgets/loops", "/api/p/acme-widgets/setup", "/api/projects/health?selected=acme-widgets", "/api/p/acme-widgets/sleep", "/api/projects", "/api/p/acme-widgets/controls"];
const CHROME_REMOTE = ["/api/p/acme-widgets/loops", "/api/p/acme-widgets/setup", "/api/projects/health?selected=acme-widgets", "/api/p/acme-widgets/bridge", "/api/projects", "/api/p/acme-widgets/controls"];

// Each project screen's body reads, on top of the chrome (literal URLs, so a renamed route shows here);
// a third entry is what the remote page reads instead.
const BODY: [Screen, string[], string[]?][] = [
  [{ page: "agents" }, ["/api/p/acme-widgets/agents", "/api/p/acme-widgets/sentinel"]],
  [
    { page: "loop", name: "rafa" },
    ["/api/p/acme-widgets/usage", "/api/p/acme-widgets/loops/rafa/notifications", "/api/p/acme-widgets/loops/rafa/history", "/api/p/acme-widgets/loops/rafa"],
  ],
  [{ page: "notifications" }, ["/api/p/acme-widgets/notifications"]],
  [{ page: "usage" }, ["/api/p/acme-widgets/usage"]],
  // The remote does not relay labels; its page draws "local only".
  [{ page: "labels" }, ["/api/p/acme-widgets/labels"], []],
  // The full lists the overview leaves out (#67).
  [{ page: "backlog" }, ["/api/p/acme-widgets/frontier"]],
  [{ page: "ci" }, ["/api/p/acme-widgets/dashboard"]],
  [{ page: "learnings" }, ["/api/p/acme-widgets/dashboard"]],
  [{ page: "ownership" }, []],
  [{ page: "reconciliation" }, []],
  [{ page: "settings" }, ["/api/p/acme-widgets/settings", "/api/p/acme-widgets/settings/prompts"]],
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
      expect(urls({ page: "intake" }, P, remote)).toEqual(["/api/p/acme-widgets/intake"]);
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
