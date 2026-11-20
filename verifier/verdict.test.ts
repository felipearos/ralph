import { describe, expect, it } from "vitest";

import { decideVerdict, type SentryIssue, type Verdict, type VerdictInput } from "./verdict";

/*
 * The verdict rules as a table: each row is the base evidence (a clean last
 * check-in on a PR alone in its deploy) with one thing changed.
 */

const DEPLOYED = "2026-10-29T12:00:00Z";

const issue = (over: Partial<SentryIssue> = {}): SentryIssue => ({
  id: "S-1",
  title: "TypeError in checkout",
  firstSeen: "2026-10-29T12:30:00Z",
  preDeployRate: 0,
  postDeployRate: 5,
  frameFiles: ["src/checkout.ts"],
  routes: [],
  events: 50,
  distinctUsers: 10,
  ...over,
});

const base = (over: Partial<VerdictInput> = {}): VerdictInput => ({
  acceptance: [{ criterion: "checkout succeeds", result: "passed" }],
  health: { reachable: true, issues: [] },
  traffic: { reachable: true, hits: 12 },
  deployedAt: DEPLOYED,
  pr: { number: 10, files: ["src/checkout.ts"], routes: ["/checkout"] },
  otherPrs: [{ number: 11, files: ["src/other.ts"], routes: ["/other"] }],
  thresholds: { rateFactor: 2, minEvents: 20, minDistinctUsers: 5 },
  trafficFloor: true,
  moreCheckInsDue: false,
  round: 1,
  mode: "act",
  ...over,
});

const withIssue = (over: Partial<SentryIssue>, rest: Partial<VerdictInput> = {}): VerdictInput =>
  base({ health: { reachable: true, issues: [issue(over)] }, ...rest });

type Row = [name: string, input: VerdictInput, expected: Partial<Verdict>, reasonHas?: RegExp];

const rows: Row[] = [
  // Revert legs.
  ["new by first-seen, attributable, impact → revert", withIssue({}), { verdict: "revert", priority: "high", act: true }, /S-1/],
  [
    "new by rate rise → revert",
    withIssue({ firstSeen: "2026-10-01T00:00:00Z", preDeployRate: 1, postDeployRate: 3 }),
    { verdict: "revert" },
    /TypeError in checkout/,
  ],
  [
    "rate rise below the factor is ignored",
    withIssue({ firstSeen: "2026-10-01T00:00:00Z", preDeployRate: 2, postDeployRate: 3 }),
    { verdict: "verified" },
  ],
  [
    "pre rate 0 and post rate 0 is ignored",
    withIssue({ firstSeen: "2026-10-01T00:00:00Z", preDeployRate: 0, postDeployRate: 0 }),
    { verdict: "verified" },
  ],
  [
    "attributable by route with leading slash differences",
    withIssue({ frameFiles: ["lib/x.ts"], routes: ["checkout"] }),
    { verdict: "revert" },
  ],
  [
    "attributable by frame file with ./ prefix",
    withIssue({ frameFiles: ["./src/checkout.ts"] }),
    { verdict: "revert" },
  ],
  [
    "unattributable → ticket",
    withIssue({ frameFiles: ["src/elsewhere.ts"], routes: ["/elsewhere"] }),
    { verdict: "ticket", priority: "normal" },
    /not attributable to PR #10/,
  ],
  [
    "shared with another PR → ticket",
    withIssue({}, { otherPrs: [{ number: 11, files: ["/src/checkout.ts"], routes: [] }] }),
    { verdict: "ticket", priority: "normal" },
    /shared with PR #11 in the same deploy/,
  ],
  [
    "below the impact bar → ticket",
    withIssue({ events: 3, distinctUsers: 1 }),
    { verdict: "ticket" },
    /below the impact bar \(3 events, 1 users\)/,
  ],
  ["impact via users only → revert", withIssue({ events: 3, distinctUsers: 5 }), { verdict: "revert" }],
  [
    "revert beats ticket and names the deciding issue",
    base({
      health: {
        reachable: true,
        issues: [issue({ id: "S-A", frameFiles: ["src/elsewhere.ts"] }), issue({ id: "S-B" })],
      },
    }),
    { verdict: "revert" },
    /S-B/,
  ],

  // Acceptance.
  [
    "hard break → revert",
    base({ acceptance: [{ criterion: "login works", result: "hard-break" }] }),
    { verdict: "revert", priority: "high" },
    /login works/,
  ],
  [
    "failed criterion → ticket",
    base({ acceptance: [{ criterion: "totals add up", result: "failed" }] }),
    { verdict: "ticket", priority: "normal" },
    /totals add up/,
  ],
  [
    "not-verifiable alone → verified",
    base({ acceptance: [{ criterion: "email arrives", result: "not-verifiable" }] }),
    { verdict: "verified" },
  ],

  // Unreachable sources.
  [
    "Sentry unreachable with check-ins due → pending",
    base({ health: { reachable: false, issues: [] }, moreCheckInsDue: true }),
    { verdict: "pending", act: true },
    /Sentry unreachable/,
  ],
  [
    "Sentry unreachable at the last check-in → inconclusive",
    base({ health: { reachable: false, issues: [] } }),
    { verdict: "inconclusive" },
    /Sentry unreachable/,
  ],
  [
    "Sentry unreachable is not revert even with a hard break",
    base({
      health: { reachable: false, issues: [issue()] },
      acceptance: [{ criterion: "login works", result: "hard-break" }],
    }),
    { verdict: "inconclusive" },
  ],
  [
    "traffic unreachable with the floor on → inconclusive",
    base({ traffic: { reachable: false, hits: 0 } }),
    { verdict: "inconclusive" },
    /traffic unreachable/,
  ],
  [
    "traffic unreachable with the floor off → still verified",
    base({ traffic: { reachable: false, hits: 0 }, trafficFloor: false }),
    { verdict: "verified" },
  ],

  // Pending and the last check-in.
  ["nothing wrong with check-ins due → pending", base({ moreCheckInsDue: true }), { verdict: "pending" }],
  ["floor on, 0 hits at the last check-in → unexercised", base({ traffic: { reachable: true, hits: 0 } }), { verdict: "unexercised" }],
  [
    "floor off, 0 hits → verified",
    base({ traffic: { reachable: true, hits: 0 }, trafficFloor: false }),
    { verdict: "verified", priority: "normal", act: true },
  ],

  // Round cap.
  [
    "round 3 ticket → needs-human",
    base({ acceptance: [{ criterion: "totals add up", result: "failed" }], round: 3 }),
    { verdict: "needs-human", priority: "high" },
    /totals add up.*round cap reached/,
  ],
  [
    "round 3 revert → needs-human",
    withIssue({}, { round: 3 }),
    { verdict: "needs-human", priority: "high" },
    /S-1.*round cap reached/,
  ],
  [
    "round 2 ticket is unchanged",
    base({ acceptance: [{ criterion: "totals add up", result: "failed" }], round: 2 }),
    { verdict: "ticket", priority: "normal" },
  ],
  ["round 2 revert is unchanged", withIssue({}, { round: 2 }), { verdict: "revert", priority: "high" }],

  // Review fixes.
  [
    "another PR owning a different frame of the same issue → shared ticket",
    withIssue(
      { frameFiles: ["src/checkout.ts", "src/payments.ts"] },
      { otherPrs: [{ number: 11, files: ["src/payments.ts"], routes: [] }] },
    ),
    { verdict: "ticket" },
    /shared with PR #11/,
  ],
  [
    "missing impact thresholds count as below the bar",
    withIssue({}, { thresholds: { rateFactor: 2, minEvents: Number.NaN, minDistinctUsers: Number.NaN } }),
    { verdict: "ticket" },
    /below the impact bar/,
  ],
  [
    "a non-finite rate factor never marks an old issue new",
    withIssue(
      { firstSeen: "2026-10-01T00:00:00Z", preDeployRate: 1, postDeployRate: 3 },
      { thresholds: { rateFactor: Number.NaN, minEvents: 20, minDistinctUsers: 5 } },
    ),
    { verdict: "verified" },
  ],
  [
    "an issue ticket keeps a failed criterion in its reason",
    withIssue({ frameFiles: ["src/elsewhere.ts"] }, { acceptance: [{ criterion: "totals add up", result: "failed" }] }),
    { verdict: "ticket" },
    /totals add up/,
  ],

  // Modes.
  ["act mode returns the revert as is", withIssue({}), { verdict: "revert", act: true, wouldHaveBeen: undefined }],
  [
    "report mode downgrades a revert to a high-priority ticket",
    withIssue({}, { mode: "report" }),
    { verdict: "ticket", priority: "high", act: true, wouldHaveBeen: "revert" },
    /S-1/,
  ],
  [
    "report mode leaves a ticket alone",
    base({ acceptance: [{ criterion: "totals add up", result: "failed" }], mode: "report" }),
    { verdict: "ticket", priority: "normal", act: true, wouldHaveBeen: undefined },
  ],
  [
    "observe mode records the revert without acting",
    withIssue({}, { mode: "observe" }),
    { verdict: "revert", priority: "high", act: false, wouldHaveBeen: "revert" },
  ],
  [
    "observe mode records a verified verdict",
    base({ mode: "observe" }),
    { verdict: "verified", act: false, wouldHaveBeen: "verified" },
  ],
  [
    "observe mode leaves pending unrecorded",
    base({ mode: "observe", moreCheckInsDue: true }),
    { verdict: "pending", act: false, wouldHaveBeen: undefined },
  ],
];

describe("decideVerdict", () => {
  it.each(rows)("%s", (_name, input, expected, reasonHas) => {
    const got = decideVerdict(input);
    for (const [key, value] of Object.entries(expected)) {
      expect(got[key as keyof Verdict], key).toBe(value);
    }
    if (reasonHas) expect(got.reason).toMatch(reasonHas);
  });
});
