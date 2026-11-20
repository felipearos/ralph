/**
 * What a role's card and page show, in the acceptance criterion's own words.
 *
 * `dashboard/adapter.test.ts` fences this table against `roles.ts` so it
 * cannot drift from the descriptors; this file says what the table is FOR, so
 * a descriptor change that legitimately moves both still has to be read
 * against what an operator sees. The wiring in `ui/app.tsx` is not asserted
 * here: this repo has no component-render tests (vitest's include is
 * `**\/*.test.ts` and UI logic is tested by extracting it), so the badge and
 * the hidden panels are verified by eye in the `/states` gallery.
 */
import { describe, expect, it } from "vitest";

import { LOOP_ROLES, ROLE_PANELS } from "./contracts";

describe("the panels a role gives meaning to", () => {
  it("shows a coder everything but the triage panel: it has no intake of its own", () => {
    expect(ROLE_PANELS.coder).toEqual({ pr: true, hostLease: true, phases: true, triage: false, ciHealth: false });
  });

  it("hides the PR, CI wait, host lease and phases panels from a triager", () => {
    // The ticket's own list. A triager ends with DONE, ALL_BLOCKED,
    // RETRY_LATER or NEEDS_TRIAGE and nothing else, so each of these would
    // describe something that cannot happen to it.
    // And it is the one role that gets the triage panel: the intake, the units
    // it has decided and what it has written are only its to show.
    expect(ROLE_PANELS.triager).toEqual({ pr: false, hostLease: false, phases: false, triage: true, ciHealth: false });
  });

  it("shows a ci-doctor the same panels as a coder, plus the CI health panel that is its own work", () => {
    expect(ROLE_PANELS["ci-doctor"]).toEqual({ pr: true, hostLease: true, phases: true, triage: false, ciHealth: true });
  });

  it("gives the CI health panel to the ci-doctor alone", () => {
    // It is the role whose preflight requires the `ci-health` label, which is
    // to say the role that FILES cases against it. For every other loop the
    // panel would be a bystander's view of somebody else's work, and the case
    // line on its card would describe something it cannot hold a lease on.
    expect(LOOP_ROLES.filter((role) => ROLE_PANELS[role].ciHealth)).toEqual(["ci-doctor"]);
  });

  it("answers for every role, so a new one cannot reach a card with no rule", () => {
    for (const role of LOOP_ROLES) expect(ROLE_PANELS[role]).toBeDefined();
  });
});
