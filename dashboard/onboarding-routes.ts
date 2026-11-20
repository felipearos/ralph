/**
 * Adding a project and setting it up, over HTTP: thin routes over
 * `onboarding.ts`.
 *
 *   - `POST /api/projects` with `{ source: "local", path }` or
 *     `{ source: "github", repo }` adds a project;
 *   - `GET /api/github/repos` lists the operator's repos to pick from;
 *   - `POST /api/projects/pick-folder` opens the host's folder dialog and
 *     answers the folder chosen, for the local checkout's Browse button;
 *   - under a project, `GET /api/setup` is its derived status, `GET
 *     /api/setup/defaults` a pre-filled candidate config, `POST
 *     /api/setup/validate` every problem with a candidate, and `POST
 *     /api/setup` writes it on a setup branch and opens the PR. A candidate
 *     with no `requiredChecks` also needs `acknowledgeNoRequiredChecks: true`.
 *   - the Tracker connector (#338): `POST /api/setup/tracker/test` asks what a
 *     Linear or Jira token can see, and `POST /api/setup/tracker/save` stores
 *     it on this host for the project's loops after testing it again. Both
 *     hand the token to `tracker.ts` on stdin and to nothing else.
 *
 * A refusal is answered with its status and `{ error, message }`, plus `path`
 * when a clone target already exists and `problems` when a config is invalid.
 *
 * `GET /api/setup` is not an observation read: for a project that is not
 * ready it fetches the base branch and asks `gh` for the setup PR, which is
 * how a merge is noticed with no refresh. `onboarding.ts` caches the answer,
 * and a ready project costs one local `cat-file`.
 */
import { json } from "./command-requests";
import type {
  AddProjectResult,
  FolderPickResult,
  GithubReposView,
  OnboardingRefusal,
  ProjectSetupView,
  ProjectView,
  SetupDefaultsView,
  SetupSubmitResult,
  SetupValidation,
  TrackerConnectReport,
  TrackerSaveResult,
} from "./contracts";
import { OnboardingError, type Onboarding } from "./onboarding";

export const PROJECTS_PATH = "/api/projects";
export const GITHUB_REPOS_PATH = "/api/github/repos";
export const PICK_FOLDER_PATH = "/api/projects/pick-folder";
export const SETUP_PATH = "/api/setup";
export const DEFAULTS_PATH = "/api/setup/defaults";
export const VALIDATE_PATH = "/api/setup/validate";
export const TRACKER_TEST_PATH = "/api/setup/tracker/test";
export const TRACKER_SAVE_PATH = "/api/setup/tracker/save";

const methodNotAllowed = (allow: string): Response =>
  new Response("method not allowed", { status: 405, headers: { allow } });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (message: string): OnboardingError => new OnboardingError(400, "InvalidRequest", message);

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw invalid("the request body must be JSON");
  }
  if (!isObject(body)) throw invalid("the request body must be a JSON object");
  return body;
}

const text = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") throw invalid(`'${key}' is required`);
  return value.trim();
};

function refusal(error: OnboardingError): Response {
  const body: OnboardingRefusal = { error: error.name, message: error.message, ...error.extra };
  return json(body, error.status);
}

/** Answer `POST /api/projects`, `GET /api/github/repos` or `POST /api/projects/pick-folder`, or return null for any other path. */
export async function handleProjectsRoute(
  request: Request,
  pathname: string,
  onboarding: Onboarding,
): Promise<Response | null> {
  try {
    if (pathname === GITHUB_REPOS_PATH) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return json({ repos: await onboarding.githubRepos() } satisfies GithubReposView);
    }
    if (pathname === PICK_FOLDER_PATH) {
      // POST: it opens a window on the host, which a prefetch must not do.
      if (request.method !== "POST") return methodNotAllowed("POST");
      return json((await onboarding.pickFolder()) satisfies FolderPickResult);
    }
    if (pathname === PROJECTS_PATH && request.method === "POST") {
      const body = await readBody(request);
      const source = body.source;
      if (source === "local") return json((await onboarding.addLocal(text(body, "path"))) satisfies AddProjectResult, 201);
      if (source === "github") return json((await onboarding.addFromGithub(text(body, "repo"))) satisfies AddProjectResult, 201);
      throw invalid("'source' must be 'local' or 'github'");
    }
    return null;
  } catch (error) {
    if (error instanceof OnboardingError) return refusal(error);
    throw error;
  }
}

/** Answer one project's `/api/setup*` routes, or return null for any other path. */
export async function handleSetupRoute(
  request: Request,
  pathname: string,
  project: ProjectView,
  onboarding: Onboarding,
): Promise<Response | null> {
  if (![SETUP_PATH, DEFAULTS_PATH, VALIDATE_PATH, TRACKER_TEST_PATH, TRACKER_SAVE_PATH].includes(pathname)) return null;
  try {
    if (pathname === TRACKER_TEST_PATH || pathname === TRACKER_SAVE_PATH) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const body = await readBody(request);
      return pathname === TRACKER_TEST_PATH
        ? json((await onboarding.testTracker(project, body)) satisfies TrackerConnectReport)
        : json((await onboarding.saveTracker(project, body)) satisfies TrackerSaveResult);
    }
    if (pathname === DEFAULTS_PATH) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return json((await onboarding.defaults(project)) satisfies SetupDefaultsView);
    }
    if (pathname === VALIDATE_PATH) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const body = await readBody(request);
      return json((await onboarding.validate(project, body.config)) satisfies SetupValidation);
    }
    if (request.method === "GET") return json((await onboarding.status(project)) satisfies ProjectSetupView);
    if (request.method !== "POST") return methodNotAllowed("GET, POST");
    const body = await readBody(request);
    return json(
      (await onboarding.submit(project, body.config, {
        acknowledgeNoRequiredChecks: body.acknowledgeNoRequiredChecks === true,
      })) satisfies SetupSubmitResult,
    );
  } catch (error) {
    if (error instanceof OnboardingError) return refusal(error);
    throw error;
  }
}

/**
 * Refuse a start on a project that is not `ready`: no loop runs against a
 * half-onboarded repo. Null when the project is ready.
 */
export async function refuseUnlessReady(project: ProjectView, onboarding: Onboarding): Promise<Response | null> {
  let view: ProjectSetupView;
  try {
    view = await onboarding.status(project);
  } catch (error) {
    // An OnboardingError already says what could not be told; anything else is wrapped.
    const message =
      error instanceof OnboardingError
        ? error.message
        : `cannot tell whether ${project.id} is set up: ${error instanceof Error ? error.message : String(error)}`;
    return json({ error: "ProjectStatusUnknown", message } satisfies OnboardingRefusal, 503);
  }
  return view.status === "ready" ? null : notReady(project, view);
}

/**
 * Answer a read that failed on a project that is not `ready` with where the
 * project stands, rather than the failure: a project with no committed config
 * has no roster to read, which is expected until setup lands. Null when the
 * project is ready or its status cannot be read, so the failure stands.
 *
 * Asked only once a read has failed, so a ready project's reads cost nothing
 * more, and a project whose loops read fine without a committed config keeps
 * being observed.
 */
export async function explainUnlessReady(project: ProjectView, onboarding: Onboarding): Promise<Response | null> {
  let view: ProjectSetupView;
  try {
    view = await onboarding.status(project);
  } catch {
    return null;
  }
  return view.status === "ready" ? null : notReady(project, view);
}

function notReady(project: ProjectView, view: ProjectSetupView): Response {
  const why =
    view.status === "setup-pending"
      ? `its setup PR is not merged yet (${view.pr?.url ?? "open"})`
      : `its .ralph/config.json is not on origin/${view.baseBranch}`;
  return json(
    { error: "ProjectNotReady", message: `${project.id} is ${view.status}: ${why}`, status: view.status } satisfies OnboardingRefusal,
    409,
  );
}
