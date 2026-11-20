import { describe, expect, it } from "vitest";

import { agentSwitch, OFF_CARD, rulesSaveCopy, rulesSaveNotice, switchNotice } from "./rules-save-model";

const PR = { url: "https://github.com/o/r/pull/9", branch: "ralph-roster/sentinel-rules-x", state: "open" as const };

describe("rulesSaveNotice", () => {
  it("says a committed save is on the base branch, with its short SHA, and that the loop picks it up on its next poll", () => {
    const notice = rulesSaveNotice(
      { outcome: "committed", commit: { branch: "main", sha: "9a5ab1a0c0ffee", subject: "ralph: sentinel rules — mode observe → file" } },
      "sentinel",
    );
    expect(notice).toEqual({ tone: "good", text: "Saved to main (9a5ab1a). The sentinel picks it up on its next poll." });
    // No PR to open, and no restart to ask for: the gate re-reads its config on every poll (#788).
    expect(notice.url).toBeUndefined();
    expect(notice.text).not.toMatch(/restart/i);
  });

  it("keeps the PR message for a project that asked for PRs", () => {
    expect(rulesSaveNotice({ outcome: "proposed", pr: PR }, "verifier")).toEqual({
      tone: "good",
      text: "Proposed the new rules. They apply once the PR is merged.",
      url: PR.url,
    });
  });

  it("says why a direct commit became a PR, and links it", () => {
    expect(rulesSaveNotice({ outcome: "proposed", pr: PR, notCommitted: "the branch is protected" }, "sentinel")).toEqual({
      tone: "warn",
      text: "Couldn't commit directly (the branch is protected), opened a PR instead. The new rules apply once it is merged.",
      url: PR.url,
    });
  });

  it("carries the reason for a refusal and a PR that was not opened", () => {
    expect(rulesSaveNotice({ outcome: "refused", why: "nothing to save" }, "sentinel")).toEqual({ tone: "bad", text: "Not saved: nothing to save" });
    expect(rulesSaveNotice({ outcome: "pr-failed", why: "gh failed" }, "verifier")).toEqual({
      tone: "warn",
      text: "The rules branch may be pushed, but the PR was not opened: gh failed",
    });
  });
});

describe("rulesSaveCopy", () => {
  it("offers Save, and says where the rules land, when the project commits", () => {
    const copy = rulesSaveCopy("commit", "main", "sentinel");
    expect(copy.button).toBe("Save rules");
    expect(copy.busy).toBe("Saving…");
    expect(copy.hint).toContain("commits the rules to main");
    expect(copy.hint).toContain("the sentinel picks them up on its next poll");
    expect(copy.hint).toContain("opens a PR instead");
  });

  it("keeps today's Propose wording when the project asks for PRs", () => {
    expect(rulesSaveCopy("pr", "dev", "verifier")).toEqual({
      button: "Propose rules",
      busy: "Proposing…",
      hint: "Save opens a PR against dev. The verifier reads the new rules once it is merged.",
    });
  });
});

describe("agentSwitch (#789)", () => {
  it("is on when the block leaves `enabled` out or says true, and the card says nothing then", () => {
    for (const rules of [null, {}, { enabled: true }]) {
      const state = agentSwitch(rules, "sentinel", "commit", "main");
      expect(state.on).toBe(true);
      expect(state.card).toBeNull();
    }
  });

  it("is off only on an explicit false, and the card says so in the config's terms", () => {
    const state = agentSwitch({ enabled: false }, "verifier", "commit", "main");
    expect(state.on).toBe(false);
    expect(state.card).toBe("Off: disabled in config");
    expect(OFF_CARD).toBe("Off: disabled in config");
    expect(state.hint).toContain("The verifier is off: its gate keeps polling");
  });

  it("says where a switch lands: at once on a committing project, by PR on one that asks for PRs", () => {
    expect(agentSwitch(null, "sentinel", "commit", "main").hint).toBe(
      "The sentinel is on. Switching saves to main at once, and the sentinel follows on its next poll.",
    );
    expect(agentSwitch(null, "sentinel", "pr", "dev").hint).toBe("The sentinel is on. Switching opens a PR against dev; it applies once merged.");
  });
});

describe("switchNotice (#789)", () => {
  const committed = (subject: string) => ({ outcome: "committed" as const, commit: { branch: "main", sha: "9a5ab1a0c0ffee", subject } });

  it("names the new state of a committed switch", () => {
    expect(switchNotice(committed("ralph: sentinel rules — enabled true → false"), "sentinel", false)).toEqual({
      tone: "good",
      text: "Switched off on main (9a5ab1a). The sentinel stops on its next poll.",
    });
    expect(switchNotice(committed("ralph: verifier rules — enabled false → true"), "verifier", true).text).toBe(
      "Switched on on main (9a5ab1a). The verifier starts on its next poll.",
    );
  });

  it("speaks as a rules save for a PR or a refusal", () => {
    expect(switchNotice({ outcome: "proposed", pr: PR }, "sentinel", false)).toEqual(rulesSaveNotice({ outcome: "proposed", pr: PR }, "sentinel"));
    expect(switchNotice({ outcome: "refused", why: "nope" }, "verifier", true)).toEqual({ tone: "bad", text: "Not saved: nope" });
  });
});
