/**
 * The view logic of Add agent, Create checkout, Delete agent worktree, a new
 * agent's card and Remove project: pure functions of the routes' answers, so
 * the page only paints what these return.
 */
import type {
  AddAgentResult,
  AgentPreflightView,
  CreateCheckoutResult,
  DeleteAgentResult,
  PendingAgentView,
  ReadinessItem,
  ReadinessState,
  RemoveProjectResult,
  RerunSetupResult,
  RosterPrView,
  StartResult,
  WorktreeSetupRecord,
  WorktreeSetupStepState,
} from "../contracts";

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

export interface Notice {
  tone: Tone;
  title: string;
  detail: string;
}

/**
 * How a readiness item paints. A `fail` is a WARNING and not an error: every
 * item is advisory, the gate a Start is actually refused by is preflight's, and
 * one of them — the worktree's position — Start fixes by itself. `unknown` is
 * neutral rather than warn, because a command that could not run says nothing
 * about the agent.
 */
const READINESS_TONE: Record<ReadinessState, Tone> = { pass: "good", fail: "warn", unknown: "neutral" };

export interface ReadinessLine {
  key: string;
  label: string;
  state: ReadinessState;
  tone: Tone;
  reason: string;
}

const readinessLine = (item: ReadinessItem): ReadinessLine => ({
  key: item.key,
  label: item.label,
  state: item.state,
  tone: READINESS_TONE[item.state],
  reason: item.reason,
});

/** The items of an agent's readiness, in the order the server sent them. */
export const readinessLines = (agent: PendingAgentView): ReadinessLine[] => agent.readiness.map(readinessLine);

/** The preflight item, once the card has asked its route for it. */
export const preflightLine = (view: AgentPreflightView): ReadinessLine => readinessLine(view.item);

export interface PendingCard {
  badge: string;
  tone: Tone;
  /**
   * The readiness items, as the card lists them. `preflight` is not among
   * them: it has a route of its own that the card asks for on request, since
   * the agents route is polled every five seconds.
   */
  readiness: ReadinessLine[];
  /** How many items are not a pass, for the summary line; 0 reads as ready. */
  outstanding: number;
  /**
   * Start is always offered: the server fetches the base branch and refuses
   * while the roster PR has not landed, so a merge unlocks it even when no
   * running loop has fetched since.
   */
  canStart: boolean;
  startHint: string;
  /**
   * `label` is the PR with its state, for a one-line link; `title` and
   * `state` are the two halves, for the dialog's status card, which shows
   * the state as a badge beside the title.
   */
  pr: { href: string; label: string; title: string; state: RosterPrView["state"] } | null;
}

const prTitle = (pr: RosterPrView): string => {
  const number = /\/pull\/(\d+)/.exec(pr.url)?.[1];
  return number === undefined ? "PR" : `PR #${number}`;
};

export function pendingCard(agent: PendingAgentView): PendingCard {
  const pr =
    agent.pr === null
      ? null
      : { href: agent.pr.url, label: `${prTitle(agent.pr)} · ${agent.pr.state}`, title: prTitle(agent.pr), state: agent.pr.state };
  const readiness = readinessLines(agent);
  const outstanding = readiness.filter((line) => line.state !== "pass").length;
  if (agent.status === "ready") {
    return {
      badge: "ready",
      tone: "good",
      readiness,
      outstanding,
      canStart: true,
      startHint: "Its roster entry is on the base branch; Start has its checkout moved up to the base branch first.",
      pr,
    };
  }
  return {
    badge: "pending merge",
    tone: agent.pr?.state === "closed" ? "bad" : "warn",
    readiness,
    outstanding,
    canStart: true,
    startHint: "Start is refused until the roster PR merges into the base branch; it checks the base branch afresh.",
    pr,
  };
}

/** The shape a name must have to be sent; the roster rules are the server's. */
export function agentNameProblem(name: string): string | null {
  if (name === "") return "Name the agent.";
  return /^[a-z][a-z0-9]*$/.test(name) ? null : "One lowercase word: a-z, then a-z or 0-9.";
}

/** Whether a setup run has a step that did not pass; a project with no steps has none. */
const setupStopped = (record: WorktreeSetupRecord | null): boolean =>
  record !== null && record.steps.some((step) => step.state !== "passed");

export function addNotice(result: AddAgentResult): Notice {
  switch (result.outcome) {
    case "added":
      // A setup that stopped leaves a worktree the agent cannot work in yet,
      // which outweighs a label the preflight would name anyway.
      if (setupStopped(result.setup)) {
        return { tone: "warn", title: `Added ${result.name}, but its setup did not finish`, detail: result.why };
      }
      // A label it could not create is a start the preflight will deny, so it
      // is a warning even though everything else worked.
      return result.labels === null
        ? { tone: "good", title: `Added ${result.name}`, detail: result.why }
        : { tone: "warn", title: `Added ${result.name}, but its labels need a hand`, detail: result.why };
    case "pr-failed":
      return { tone: "warn", title: `Added ${result.name}, but the roster PR was not opened`, detail: result.why };
    case "refused":
      return { tone: "bad", title: "Add agent refused, nothing was created", detail: result.why };
  }
}

export function deleteNotice(result: DeleteAgentResult): Notice {
  switch (result.outcome) {
    case "deleted":
      return { tone: "good", title: `Deleted ${result.name}'s worktree`, detail: result.why };
    case "pr-failed":
      return { tone: "warn", title: `Deleted ${result.name}'s worktree, but the roster PR was not opened`, detail: result.why };
    case "refused":
      return { tone: "bad", title: "Delete refused, nothing was removed", detail: result.why };
  }
}

export function checkoutNotice(result: CreateCheckoutResult): Notice {
  switch (result.outcome) {
    case "created":
      // A label it could not create is a start the preflight will deny, the
      // same reason `addNotice` warns over one.
      return result.labels === null
        ? { tone: "good", title: `Created ${result.name}'s checkout`, detail: result.why }
        : { tone: "warn", title: `Created ${result.name}'s checkout, but its labels need a hand`, detail: result.why };
    case "incomplete":
      return setupStopped(result.setup)
        ? { tone: "warn", title: `${result.name}'s worktree is there, but its setup did not finish`, detail: result.why }
        : { tone: "warn", title: `${result.name}'s worktree is there, but it was not finished`, detail: result.why };
    case "refused":
      return { tone: "bad", title: "Create checkout refused, nothing was created", detail: result.why };
  }
}

export function rerunNotice(result: RerunSetupResult): Notice {
  switch (result.outcome) {
    case "passed":
      return { tone: "good", title: `Setup passed in ${result.name}'s worktree`, detail: result.why };
    case "failed":
      return { tone: "warn", title: `${result.name}'s setup did not finish`, detail: result.why };
    case "refused":
      return { tone: "bad", title: "Rerun setup refused, nothing was run", detail: result.why };
  }
}

export interface SetupLine {
  name: string;
  state: WorktreeSetupStepState;
  tone: Tone;
  summary: string;
  /** The output's tail; "" when the step printed nothing or never ran. */
  output: string;
}

const SETUP_TONE: Record<WorktreeSetupStepState, Tone> = { passed: "good", failed: "bad", timeout: "bad", skipped: "neutral" };

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function setupSummary(step: WorktreeSetupRecord["steps"][number]): string {
  const took = step.durationMs === null ? "" : ` after ${seconds(step.durationMs)}`;
  switch (step.state) {
    case "passed":
      return `passed${step.durationMs === null ? "" : ` in ${seconds(step.durationMs)}`}`;
    case "timeout":
      // The limit, not the measured time: it is the number the config names.
      return `timed out after ${Math.round(step.limitMs / 1000)}s`;
    case "skipped":
      return "skipped: an earlier step did not pass";
    case "failed":
      if (step.error !== null) return `could not start: ${step.error}`;
      return step.exitCode === null ? `failed${took}` : `failed with exit code ${step.exitCode}${took}`;
  }
}

/** A setup run's steps, in config order, as the page lists them; none for a project without steps. */
export const setupLines = (record: WorktreeSetupRecord | null): SetupLine[] =>
  (record?.steps ?? []).map((step) => ({
    name: step.name,
    state: step.state,
    tone: SETUP_TONE[step.state],
    summary: setupSummary(step),
    output: step.output,
  }));

export function startNotice(result: StartResult): Notice {
  switch (result.outcome) {
    case "started":
      return { tone: "good", title: `Started ${result.loop}`, detail: result.why };
    case "already-running":
      return { tone: "neutral", title: "Already running, nothing launched", detail: result.why };
    case "refused":
      return { tone: "warn", title: "Start refused, nothing was started", detail: result.why };
    case "failed":
    case "not-for-this-loop":
      return { tone: "bad", title: "Start failed", detail: result.why };
  }
}

export function removeNotice(result: RemoveProjectResult): Notice {
  if (result.outcome === "removed") return { tone: "good", title: `Removed ${result.project}`, detail: result.why };
  return {
    tone: "bad",
    title: `Remove refused, ${result.project} stays registered`,
    detail: [result.why, ...result.running].join("\n"),
  };
}

/**
 * The Add agent dialog's steps, in order. `name` and `review` come before
 * anything exists; `pr` and `ready` describe an agent that does.
 */
export const FLOW_STEPS = ["name", "review", "pr", "ready"] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

export const FLOW_STEP_LABELS: Record<FlowStep, string> = {
  name: "Name & role",
  review: "Review",
  pr: "Roster PR",
  ready: "Ready & start",
};

/**
 * Where reopening a new agent's setup lands: on its roster PR while that has
 * not merged, and on readiness once it has. The dialog can be closed at any
 * step after Create, so this is read from the server's answer, never kept.
 */
export const resumeStep = (agent: PendingAgentView): FlowStep => (agent.status === "ready" ? "ready" : "pr");
