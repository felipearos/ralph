/**
 * The project's tracker, built from its config (felipearos/ralph#330).
 *
 * GitHub needs nothing but the config: `gh` carries its own auth. Linear and
 * Jira need the host-side credential, and a project without one is "not
 * connected", which callers treat as a degraded tracker (wait and retry), not
 * as a crash. A local tracker is a file on the host and needs none.
 */
import type { ProjectConfig, TrackerConfig } from "../project-config";
import { readCredential, type TrackerCredential } from "./credentials";
import { createGithubTracker, type GithubTrackerOptions } from "./github";
import { createJiraTracker } from "./jira";
import { createLinearTracker } from "./linear";
import { createLocalTracker } from "./local";
import { TrackerUnavailableError, type Tracker } from "./types";

export * from "./types";

/** What builds a Linear or Jira adapter from its config block and credential. */
export type KeyedAdapterFactory<K extends "linear" | "jira"> = (
  config: Extract<TrackerConfig, { kind: K }>,
  credential: Extract<TrackerCredential, { kind: K }>,
) => Tracker;

/** The keyed adapters this harness has, by kind. */
const KEYED_ADAPTERS: { linear?: KeyedAdapterFactory<"linear">; jira?: KeyedAdapterFactory<"jira"> } = {
  linear: (config, credential) =>
    createLinearTracker({
      team: config.team,
      workspace: config.workspace,
      scopeLabel: config.scopeLabel,
      states: config.states,
      apiKey: credential.apiKey,
    }),
  jira: (config, credential) =>
    createJiraTracker({
      site: config.site,
      project: config.project,
      scopeLabel: config.scopeLabel,
      states: config.states,
      email: credential.email,
      apiToken: credential.apiToken,
    }),
};

export interface CreateTrackerOptions {
  /** Keys the credential file. */
  projectId: string;
  env?: Record<string, string | undefined>;
  /** Overrides for the GitHub adapter's command runners (tests). */
  github?: Pick<GithubTrackerOptions, "gh" | "read">;
}

export function createTracker(
  config: Pick<ProjectConfig, "repo" | "owner" | "tracker">,
  options: CreateTrackerOptions,
): Tracker {
  const tracker = config.tracker;
  if (tracker.kind === "github") {
    return createGithubTracker({ repo: config.repo, owner: config.owner, ...options.github });
  }
  // Keyed, but its tickets are a file on this host: there is no service to
  // authenticate to, so it never reads (or waits on) a credential.
  if (tracker.kind === "local") {
    // `self` is who a no-login assign() names, the login the frontier reads its own claims back as.
    return createLocalTracker({ file: tracker.file, key: tracker.key, states: tracker.states, self: config.owner });
  }
  const reading = readCredential(options.projectId, options.env);
  if (reading.status === "not-connected") {
    throw new TrackerUnavailableError(
      `project '${options.projectId}' has a ${tracker.kind} tracker but no credential at ${reading.path}; connect it from the dashboard`,
      "not-connected",
    );
  }
  if (reading.status === "invalid") {
    throw new TrackerUnavailableError(`the ${tracker.kind} credential at ${reading.path} is unusable: ${reading.problem}`, "not-connected");
  }
  if (reading.credential.kind !== tracker.kind) {
    throw new TrackerUnavailableError(
      `the credential for '${options.projectId}' is for ${reading.credential.kind}, but the project's tracker is ${tracker.kind}`,
      "not-connected",
    );
  }
  if (tracker.kind === "linear" && KEYED_ADAPTERS.linear) {
    return KEYED_ADAPTERS.linear(tracker, reading.credential as Extract<TrackerCredential, { kind: "linear" }>);
  }
  if (tracker.kind === "jira" && KEYED_ADAPTERS.jira) {
    return KEYED_ADAPTERS.jira(tracker, reading.credential as Extract<TrackerCredential, { kind: "jira" }>);
  }
  throw new TrackerUnavailableError(`this harness has no ${tracker.kind} adapter yet (felipearos/ralph#330)`, "no-adapter");
}
