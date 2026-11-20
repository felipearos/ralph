/**
 * How the dashboard names and links a ticket on each tracker (felipearos/ralph#339):
 * read off the project's config, carried on the snapshot, and applied by
 * every view through one helper.
 */
import { afterEach, describe, expect, it } from "vitest";

import { trackerKindOf, trackerLinkFor } from "./adapter";
import { issueHref, issueRef, setTrackerLinks } from "./ui/issue-link";

const REPO = "https://github.com/acme/widgets";

describe("the tracker a project's config names", () => {
  it("is GitHub's issues when the config names none, or cannot be read", () => {
    expect(trackerKindOf({ repo: "acme/widgets" })).toBe("github");
    expect(trackerKindOf(null)).toBe("github");
    expect(trackerLinkFor({ tracker: { kind: "github" } }, REPO)).toEqual({ kind: "github", prefix: "#", link: `${REPO}/issues/{n}` });
    expect(trackerLinkFor(null, null)).toEqual({ kind: "github", prefix: "#", link: null });
  });

  it("links a Linear ticket under its workspace and spells it with the team key", () => {
    const config = { tracker: { kind: "linear", team: "AND", workspace: "exampleorg" } };
    expect(trackerKindOf(config)).toBe("linear");
    expect(trackerLinkFor(config, REPO)).toEqual({ kind: "linear", prefix: "AND-", link: "https://linear.app/exampleorg/issue/AND-{n}" });
  });

  it("spells a local sandbox ticket with its key and links it nowhere (#527)", () => {
    const config = { tracker: { kind: "local", key: "SBX", file: "/tmp/tickets.json" } };
    expect(trackerKindOf(config)).toBe("local");
    expect(trackerLinkFor(config, REPO)).toEqual({ kind: "local", prefix: "SBX-", link: null });
  });

  it("links a Jira ticket under its site", () => {
    expect(trackerLinkFor({ tracker: { kind: "jira", site: "example.atlassian.net", project: "OA" } }, REPO)).toEqual({
      kind: "jira",
      prefix: "OA-",
      link: "https://example.atlassian.net/browse/OA-{n}",
    });
  });
});

describe("the views' ticket links", () => {
  afterEach(() => setTrackerLinks(null));

  it("are GitHub issues until a snapshot says otherwise", () => {
    expect(issueHref(REPO, 184)).toBe(`${REPO}/issues/184`);
    expect(issueHref(null, 184)).toBeNull();
    expect(issueRef(184)).toBe("#184");
  });

  it("follow the project's tracker once the snapshot names it", () => {
    setTrackerLinks({ kind: "linear", prefix: "AND-", link: "https://linear.app/exampleorg/issue/AND-{n}" });
    expect(issueHref(REPO, 184)).toBe("https://linear.app/exampleorg/issue/AND-184");
    expect(issueRef(184)).toBe("AND-184");
  });

  it("never point a Linear or Jira ticket at the GitHub issue of the same number", () => {
    setTrackerLinks({ kind: "jira", prefix: "OA-", link: null });
    expect(issueHref(REPO, 410)).toBeNull();
    expect(issueRef(410)).toBe("OA-410");
  });
});
