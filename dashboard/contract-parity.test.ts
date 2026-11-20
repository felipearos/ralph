// @vitest-environment node
/**
 * `dashboard/contracts.ts` is the dashboard's standalone contract surface and
 * imports nothing from the harness, so every enumeration it validates against
 * is a hand-kept copy of the harness's own. A copy that drifts is not a type
 * error — it is a runtime throw in front of the operator: `adapter.ts`
 * validates with `oneOf`, which `fail()`s on a value its list does not hold,
 * and `frontier/next-tasks.ts` spreads raw `BlockReason`s straight into
 * `stuckReasons`. So a new `BlockKind` reaches the dashboard the moment it
 * exists.
 *
 * This file is that fence (felipearos/ralph#155). It asserts the lists are
 * identical rather than merely compatible: order is part of the contract,
 * since both are read as `readonly T[]` by `oneOf` and rendered in list order
 * in refusals.
 */
import { readFileSync } from "node:fs";
import { basename, join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BLOCK_KINDS as HARNESS_BLOCK_KINDS,
  JOURNAL_BLOCK_KINDS as HARNESS_JOURNAL_BLOCK_KINDS,
} from "../block-reason";
import {
  CI_HEALTH_VERSION,
  METRICS_DAYS,
  STORE_RELATIVE_PATH as HARNESS_STORE_PATH,
  weigh as harnessWeigh,
  type CaseKind,
  type CaseState,
  type CiHealthStore,
  type Revert,
} from "../ci-doctor/store";
import { READY_LABEL, URGENT_LABEL, type ParkReason as HarnessParkReason } from "../frontier/next-tasks";
import { CONDITION_KINDS as HARNESS_CONDITION_KINDS, type Condition as HarnessCondition } from "../park-store";
import type { IntakeMetricsOutput as HarnessIntakeMetrics } from "../clerk-intake";
import {
  INTAKE_ASSIGNEES as HARNESS_INTAKE_ASSIGNEES,
  INTAKE_PR_STATES as HARNESS_INTAKE_PR_STATES,
  INTAKE_STAGES as HARNESS_INTAKE_STAGES,
  type IntakeTicket as HarnessIntakeTicket,
} from "../clerk/intake-snapshot";
import type { ParticipationRow as HarnessParticipationRow, SummaryRow as HarnessSummaryRow } from "../clerk/metrics";
import { RESULT_DIR as HARNESS_WAIT_DIR, resultPath as harnessResultPath } from "../merge-wait";
import {
  FOLLOWING_STATES as HARNESS_FOLLOWING_STATES,
  FOLLOWING_VERSION as HARNESS_FOLLOWING_VERSION,
  WOULD_BE_KINDS as HARNESS_FOLLOWING_WOULD_BE,
} from "../verifier/following";
import {
  RETRY_CEILINGS,
  SENTINEL_DEFAULTS as HARNESS_SENTINEL_DEFAULTS,
  SENTINEL_MODES as HARNESS_SENTINEL_MODES,
  SENTINEL_RULE_KEYS as HARNESS_SENTINEL_RULE_KEYS,
  VERIFIER_DEFAULTS as HARNESS_VERIFIER_DEFAULTS,
  VERIFIER_MODES as HARNESS_VERIFIER_MODES,
} from "../project-config";
import {
  SENTINEL_ISSUE_STATES as HARNESS_SENTINEL_ISSUE_STATES,
  SENTINEL_ISSUES_VIEW_VERSION as HARNESS_SENTINEL_ISSUES_VIEW_VERSION,
} from "../sentinel/issues";
import {
  CHAT_MODES as HARNESS_CHAT_MODES,
  HANDBACK_STEPS as HARNESS_HANDBACK_STEPS,
  type ChatEvent as HarnessChatEvent,
  type ChatMode as HarnessChatMode,
  type ChatView as HarnessChatView,
  type HandbackOutcome as HarnessHandbackOutcome,
  type HandbackStep as HarnessHandbackStep,
  type StartedChat as HarnessStartedChat,
} from "./chat";
import type { HandbackResult as HarnessHandbackResult } from "./chat-handback";
import type { StopAndFixAnswer as HarnessStopAndFixAnswer } from "./chat-routes";

import {
  STORE_RELATIVE_PATH as CONTRACT_STORE_PATH,
  STORE_VERSION as CONTRACT_STORE_VERSION,
  WAIT_LOG_DIR as CONTRACT_WAIT_DIR,
  WAIT_RESULT,
  weigh as contractWeigh,
} from "./ci-health";

import {
  BLOCK_KINDS as CONTRACT_BLOCK_KINDS,
  CODER_FRONTIER_LABELS,
  CI_CASE_KINDS,
  CI_CASE_STATES,
  CI_MAIN_STATES,
  CI_KNOWN_FLAKE_STATES,
  CI_METRICS_TREND_DAYS,
  CI_RETRY_PER_DAY_DEFAULT,
  CI_REVERT_STATES,
  JOURNAL_BLOCK_KINDS as CONTRACT_JOURNAL_BLOCK_KINDS,
  PARK_CONDITION_KINDS as CONTRACT_PARK_CONDITION_KINDS,
  type ParkCondition as ContractParkCondition,
  type ParkReason as ContractParkReason,
  CHAT_MODES as CONTRACT_CHAT_MODES,
  INTAKE_ASSIGNEES as CONTRACT_INTAKE_ASSIGNEES,
  INTAKE_PR_STATES as CONTRACT_INTAKE_PR_STATES,
  INTAKE_STAGES as CONTRACT_INTAKE_STAGES,
  VERIFIER_MODES as CONTRACT_VERIFIER_MODES,
  FOLLOWING_STATES as CONTRACT_FOLLOWING_STATES,
  FOLLOWING_WOULD_BE as CONTRACT_FOLLOWING_WOULD_BE,
  type FollowingView as ContractFollowingView,
  VERIFIER_RULE_DEFAULTS as CONTRACT_VERIFIER_RULE_DEFAULTS,
  SENTINEL_MODES as CONTRACT_SENTINEL_MODES,
  SENTINEL_RULE_KEYS as CONTRACT_SENTINEL_RULE_KEYS,
  SENTINEL_RULE_DEFAULTS as CONTRACT_SENTINEL_RULE_DEFAULTS,
  SENTINEL_ISSUE_STATES as CONTRACT_SENTINEL_ISSUE_STATES,
  type SentinelIssuesView as ContractSentinelIssuesView,
  type IntakeMetricsRow as ContractIntakeMetricsRow,
  type IntakeMetricsView as ContractIntakeMetrics,
  type IntakeParticipationRow as ContractParticipationRow,
  type IntakeTicketView as ContractIntakeTicket,
  HANDBACK_STEPS as CONTRACT_HANDBACK_STEPS,
  type ChatEvent as ContractChatEvent,
  type ChatMode as ContractChatMode,
  type ChatView as ContractChatView,
  type HandbackOutcome as ContractHandbackOutcome,
  type HandbackResult as ContractHandbackResult,
  type HandbackStep as ContractHandbackStep,
  type StartedChat as ContractStartedChat,
  type StopAndFixAnswer as ContractStopAndFixAnswer,
} from "./contracts";

/*
 * The ci-health unions have no runtime array on the harness side — they are
 * bare type aliases — so the fence runs the other way for them: each list
 * below is declared `satisfies readonly T[]` against the harness type AND
 * asserted exhaustive through a `Record<T, true>`, so ADDING a member in
 * `ci-doctor/store.ts` fails the typecheck here and REMOVING one fails the
 * `satisfies`. The `expect` then pins the order, which the dashboard's
 * narrowing and its rendered lists both depend on.
 */
const HARNESS_CASE_KINDS = ["flake", "regression", "infra", "pr-specific", "parked"] satisfies readonly CaseKind[];
const HARNESS_CASE_STATES = [
  "candidate",
  "confirmed",
  "filed",
  "fixing",
  "fixed",
  "retired",
  "handed-off",
] satisfies readonly CaseState[];
const HARNESS_MAIN_STATES = ["green", "red", "unknown"] satisfies readonly CiHealthStore["main"]["state"][];
const HARNESS_REVERT_STATES = ["open", "merged", "abandoned"] satisfies readonly Revert["state"][];

/** Every member of the harness union is in the list above it; a new one breaks this line. */
const EXHAUSTIVE: [Record<CaseKind, true>, Record<CaseState, true>, Record<CiHealthStore["main"]["state"], true>, Record<Revert["state"], true>] = [
  { flake: true, regression: true, infra: true, "pr-specific": true, parked: true },
  { candidate: true, confirmed: true, filed: true, fixing: true, fixed: true, retired: true, "handed-off": true },
  { green: true, red: true, unknown: true },
  { open: true, merged: true, abandoned: true },
];

describe("the dashboard's copies of the harness enumerations", () => {
  it("credits coders with exactly the labels their frontier reads", () => {
    expect(CODER_FRONTIER_LABELS).toEqual([READY_LABEL, URGENT_LABEL]);
  });

  it("lists exactly the block kinds block-reason.ts does, in the same order", () => {
    expect([...CONTRACT_BLOCK_KINDS]).toEqual([...HARNESS_BLOCK_KINDS]);
  });

  it("lists exactly the journal block kinds too — the narrower list adapter.ts validates against", () => {
    expect([...CONTRACT_JOURNAL_BLOCK_KINDS]).toEqual([...HARNESS_JOURNAL_BLOCK_KINDS]);
  });

  it("keeps the journal list a subset of the block kinds, since a journal reads the same blocks", () => {
    for (const kind of HARNESS_JOURNAL_BLOCK_KINDS) expect(HARNESS_BLOCK_KINDS).toContain(kind);
  });

  it("lists exactly the ci-health case kinds ci-doctor/store.ts does, in the same order", () => {
    expect([...CI_CASE_KINDS]).toEqual([...HARNESS_CASE_KINDS]);
    expect(Object.keys(EXHAUSTIVE[0])).toHaveLength(CI_CASE_KINDS.length);
  });

  it("lists exactly the ci-health case states, in the same order", () => {
    expect([...CI_CASE_STATES]).toEqual([...HARNESS_CASE_STATES]);
    expect(Object.keys(EXHAUSTIVE[1])).toHaveLength(CI_CASE_STATES.length);
  });

  it("lists exactly the main colours the store records, in the same order", () => {
    expect([...CI_MAIN_STATES]).toEqual([...HARNESS_MAIN_STATES]);
    expect(Object.keys(EXHAUSTIVE[2])).toHaveLength(CI_MAIN_STATES.length);
  });

  it("lists exactly the revert states, in the same order", () => {
    expect([...CI_REVERT_STATES]).toEqual([...HARNESS_REVERT_STATES]);
    expect(Object.keys(EXHAUSTIVE[3])).toHaveLength(CI_REVERT_STATES.length);
  });

  it("looks for the store where ci-doctor/store.ts writes it", () => {
    // The harness side is a hardcoded literal with a forward slash; the
    // dashboard side goes through `node:path.join`, which uses the platform
    // separator. They resolve to the same file either way, so the comparison
    // is normalised rather than literal — otherwise this would fail on a
    // platform where the two agree perfectly well.
    expect(CONTRACT_STORE_PATH.split(sep).join("/")).toBe(HARNESS_STORE_PATH);
  });

  it("reads the store version the harness writes, so a bump cannot silently empty the panel", () => {
    // The dangerous direction: `foldCiHealth` folds a store of another version
    // to the EMPTY view with no problem reported, so a harness that moved to 2
    // while this said 1 would draw a clean all-zero picture of a project it
    // could not read.
    expect(CONTRACT_STORE_VERSION).toBe(CI_HEALTH_VERSION);
  });

  it("draws no more trend days than ci-doctor/scan.ts keeps metrics for", () => {
    // A panel asking for 40 days of a 30-day retention would draw ten
    // permanent zeros and read as a quiet fortnight that never happened.
    expect(CI_METRICS_TREND_DAYS).toBeLessThanOrEqual(METRICS_DAYS);
  });

  it("looks for wait results in the directory the harness writes them to, by the name it uses", () => {
    expect(CONTRACT_WAIT_DIR.split(sep).join("/")).toBe(HARNESS_WAIT_DIR.split(sep).join("/"));

    // THE SUPERVISOR IS THE DOMINANT WRITER, and it is a bash literal — read
    // `ralph.sh` rather than restating it. A hand-copied example filename
    // would keep passing after someone moved that path or renamed the prefix,
    // while `ciMinutes` went permanently null, which is exactly the failure
    // `ci-health.ts`'s comment claims this fences.
    const shell = readFileSync(join(import.meta.dirname, "..", "ralph.sh"), "utf8");
    const assigned = /^\s*result="([^"]*pr-wait[^"]*)"/m.exec(shell);
    expect(assigned).not.toBeNull();
    const template = assigned![1]!;
    expect(template.startsWith(`${CONTRACT_WAIT_DIR.split(sep).join("/")}/`)).toBe(true);
    // The template with its four shell expansions filled in is a name the
    // dashboard matches, with the round captured as the round.
    const filled = basename(template)
      .replace("${ts}", "20261005T203634")
      .replace("$$", "437810")
      .replace("${i}", "1")
      .replace("${PR_WAIT_ROUND}", "2");
    expect(filled).not.toContain("$");
    const supervisor = WAIT_RESULT.exec(filled);
    expect(supervisor?.[1]).toBe("20261005T203634-437810-1");
    expect(supervisor?.[2]).toBe("2");

    // And `merge-wait.ts`'s own name, so an in-iteration queue wait is counted
    // too. Taken from the function rather than restated, for the same reason.
    const filed = basename(harnessResultPath({ RALPH_PROJECT: "/nowhere", RALPH_RUN_ID: "run-a", RALPH_ITERATION: "7" }));
    expect(WAIT_RESULT.exec(filed)?.[1]).toBe("session-runa-7");

    // The append-only history beside them holds the SAME records; reading it
    // would double every wait.
    expect(WAIT_RESULT.test("pr-wait-20261005T203634-437810-1.jsonl")).toBe(false);
  });

  it("decides for EVERY case state whether a flake in it is still costing CI time", () => {
    // Not a mirror of anything: `known.ts`'s `flakeClaim` answers "what do I
    // tell a coder about this test", which is a different question. So this
    // asserts no harness value — its bite is the `Record<CaseState, …>`, which
    // makes a state added to `ci-doctor/store.ts` fail the TYPECHECK here, so
    // somebody has to decide which side of the line it falls on rather than
    // letting it default into "not costing anything".
    const STILL_COSTING: Record<CaseState, boolean> = {
      // The doctor has not established it is a flake at all.
      candidate: false,
      confirmed: true,
      filed: true,
      fixing: true,
      // Filed for the coders, so the test is still flaking and still burning
      // builds — it is somebody else's to fix, which is not the same as over.
      // `known.ts` says so too, printing `flake handed to the coders` WITH its
      // cost clause.
      "handed-off": true,
      // Over.
      fixed: false,
      retired: false,
    };
    const expected = (Object.keys(STILL_COSTING) as CaseState[]).filter((state) => STILL_COSTING[state]);
    expect([...CI_KNOWN_FLAKE_STATES].sort()).toEqual([...expected].sort());
  });

  it("weighs a case exactly as ci-doctor/store.ts does, so the table's order is the doctor's", () => {
    for (const cost of [
      { redBuilds: 0, mainReds: 0, dequeues: 0 },
      { redBuilds: 1, mainReds: 0, dequeues: 0 },
      { redBuilds: 0, mainReds: 1, dequeues: 0 },
      { redBuilds: 0, mainReds: 0, dequeues: 1 },
      { redBuilds: 9, mainReds: 2, dequeues: 3 },
    ]) {
      expect(contractWeigh(cost)).toBe(harnessWeigh(cost));
    }
  });

  it("reads the doctor's daily retry cap off the ceiling project-config.ts enforces", () => {
    // The key may be lowered but never raised, so the ceiling IS the default:
    // a project that configures nothing is held to the most the doctor may spend.
    expect(CI_RETRY_PER_DAY_DEFAULT).toBe(RETRY_CEILINGS.perDay);
  });
});

/*
 * The unblocker chat's wire shapes (#256). The page reads `contracts.ts`'s
 * copies; the server writes `chat.ts`'s, `chat-routes.ts`'s and
 * `chat-handback.ts`'s. Mutual assignability is the fence: a field added,
 * dropped or retyped on either side fails the TYPECHECK on one of these lines,
 * and the runtime lists are pinned in order, since the panel draws the
 * handback's steps in it.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const CHAT_SHAPES_AGREE: [
  Same<HarnessChatEvent, ContractChatEvent>,
  Same<HarnessChatView, ContractChatView>,
  Same<HarnessStartedChat, ContractStartedChat>,
  Same<HarnessChatMode, ContractChatMode>,
  Same<HarnessHandbackStep, ContractHandbackStep>,
  Same<HarnessHandbackOutcome, ContractHandbackOutcome>,
  Same<HarnessStopAndFixAnswer, ContractStopAndFixAnswer>,
  Same<HarnessHandbackResult, ContractHandbackResult>,
] = [true, true, true, true, true, true, true, true];

describe("the dashboard's copy of the chat's wire shapes", () => {
  it("agrees with chat.ts, chat-routes.ts and chat-handback.ts field for field", () => {
    expect(CHAT_SHAPES_AGREE.every(Boolean)).toBe(true);
  });

  it("lists exactly the modes and handback steps chat.ts does, in the same order", () => {
    expect([...CONTRACT_CHAT_MODES]).toEqual([...HARNESS_CHAT_MODES]);
    expect([...CONTRACT_HANDBACK_STEPS]).toEqual([...HARNESS_HANDBACK_STEPS]);
  });
});

/** The intake page's shapes (felipearos/ralph#459): the CLI's output and the dashboard's copy, field for field. */
const INTAKE_SHAPES_AGREE: [
  Same<HarnessIntakeTicket, ContractIntakeTicket>,
  Same<HarnessSummaryRow, ContractIntakeMetricsRow>,
  Same<HarnessParticipationRow, ContractParticipationRow>,
  Same<HarnessIntakeMetrics, ContractIntakeMetrics>,
] = [true, true, true, true];

/** The frontier's park on a stuck ticket (#776/#777): park-store and next-tasks' shapes and the dashboard's copy, field for field. */
// The third pins park-store's kind list to its union both ways: `satisfies`
// there stops the list naming a kind the union lacks, not missing one it has,
// and a kind missing from both lists would pass the order check below while the
// adapter's `oneOf` refused every park of that kind.
const PARK_SHAPES_AGREE: [
  Same<HarnessParkReason, ContractParkReason>,
  Same<HarnessCondition, ContractParkCondition>,
  Same<HarnessCondition["kind"], (typeof HARNESS_CONDITION_KINDS)[number]>,
] = [true, true, true];

describe("the dashboard's copy of a stuck ticket's park", () => {
  it("agrees with park-store.ts and frontier/next-tasks.ts field for field", () => {
    expect(PARK_SHAPES_AGREE.every(Boolean)).toBe(true);
  });

  it("lists exactly the condition kinds park-store.ts does, in the same order", () => {
    // `adapter.ts` validates a park's condition with `oneOf`, which throws on
    // a kind its list lacks, so a kind added there and not here breaks the read.
    expect([...CONTRACT_PARK_CONDITION_KINDS]).toEqual([...HARNESS_CONDITION_KINDS]);
  });
});

describe("the dashboard's copy of the intake page's shapes", () => {
  it("agrees with clerk/intake-snapshot.ts, clerk/metrics.ts and clerk-intake.ts field for field", () => {
    expect(INTAKE_SHAPES_AGREE.every(Boolean)).toBe(true);
  });

  it("lists exactly the stages, assignee kinds and PR states the snapshot does, in the same order", () => {
    expect([...CONTRACT_INTAKE_STAGES]).toEqual([...HARNESS_INTAKE_STAGES]);
    expect([...CONTRACT_INTAKE_ASSIGNEES]).toEqual([...HARNESS_INTAKE_ASSIGNEES]);
    expect([...CONTRACT_INTAKE_PR_STATES]).toEqual([...HARNESS_INTAKE_PR_STATES]);
  });
});

describe("the dashboard's copy of the Following view", () => {
  it("knows exactly the watch states and held-back verdicts verifier/following.ts prints", () => {
    // `narrowFollowing` drops a watch whose enum it does not know, so a value
    // added there and not here would silently vanish from the panel.
    expect([...CONTRACT_FOLLOWING_STATES]).toEqual([...HARNESS_FOLLOWING_STATES]);
    expect([...CONTRACT_FOLLOWING_WOULD_BE]).toEqual([...HARNESS_FOLLOWING_WOULD_BE]);
  });

  it("expects the version the CLI prints", () => {
    const version: ContractFollowingView["version"] = HARNESS_FOLLOWING_VERSION;
    expect(version).toBe(1);
  });
});

describe("the dashboard's copy of the verifier rules", () => {
  it("lists exactly the modes project-config.ts does, in the same order", () => {
    expect([...CONTRACT_VERIFIER_MODES]).toEqual([...HARNESS_VERIFIER_MODES]);
  });

  it("defaults every rule as VERIFIER_DEFAULTS does, which also names a deploy environment that is no rule", () => {
    const { environment: _environment, ...harnessRules } = HARNESS_VERIFIER_DEFAULTS;
    expect(CONTRACT_VERIFIER_RULE_DEFAULTS).toEqual(harnessRules);
  });
});

describe("the dashboard's copy of the sentinel rules", () => {
  it("lists exactly the modes project-config.ts does, in the same order", () => {
    expect([...CONTRACT_SENTINEL_MODES]).toEqual([...HARNESS_SENTINEL_MODES]);
  });

  it("edits exactly the rule keys project-config.ts does", () => {
    // `--set-sentinel` refuses a key outside SENTINEL_RULE_KEYS, so a key the
    // form sends and the harness does not know would refuse every Save.
    expect([...CONTRACT_SENTINEL_RULE_KEYS]).toEqual([...HARNESS_SENTINEL_RULE_KEYS]);
    expect(Object.keys(CONTRACT_SENTINEL_RULE_DEFAULTS).sort()).toEqual([...HARNESS_SENTINEL_RULE_KEYS].sort());
  });

  it("defaults every rule as SENTINEL_DEFAULTS does", () => {
    expect(CONTRACT_SENTINEL_RULE_DEFAULTS).toEqual(HARNESS_SENTINEL_DEFAULTS);
  });
});

describe("the dashboard's copy of the sentinel issues view", () => {
  it("knows exactly the issue states sentinel/issues.ts prints", () => {
    // The adapter drops a row whose state it does not know, so a state added
    // there and not here would silently vanish from the panel.
    expect([...CONTRACT_SENTINEL_ISSUE_STATES]).toEqual([...HARNESS_SENTINEL_ISSUE_STATES]);
  });

  it("expects the version the CLI prints", () => {
    const version: ContractSentinelIssuesView["version"] = HARNESS_SENTINEL_ISSUES_VIEW_VERSION;
    expect(version).toBe(1);
  });
});
