/**
 * Every relayed command's request parser, and the request helpers they share,
 * in one place.
 *
 * One parser per command: the local routes answer a malformed body with it,
 * and the remote Vercel function refuses the same body with the same 400
 * before relaying it, so the two can never disagree about which body is
 * well-formed. The remote function must never import the adapters' graph —
 * no CLI, filesystem or process code may reach a serverless bundle — so this
 * file imports only `./contracts`, which itself imports nothing. The
 * vocabulary below is the dispatch layer's, kept here so both sides read it
 * from the one copy.
 *
 * Only shape is judged here. Run ownership, replay, approval and roster
 * semantics are dispatch's, lifecycle's and `project-config`'s, and are
 * reached through them rather than restated.
 */
import { CONTROL_COMMANDS, EVAL_AXES, ORDERLY_STOP_KINDS, PHASES, type EvalAxis, type Phase, type RelayedCommandKind, type StopKind } from "./contracts";

/**
 * The actions this dispatch layer owns: `controls.ts`'s whole command
 * roster. `start` and `restart-to-apply` are the lifecycle's, not the
 * channel's, and are not sent from here. A name outside this list is a request
 * error, not a silent no-op. It is the contracts' `CONTROL_COMMANDS`, the
 * page's own list, so the two cannot drift.
 */
export const DISPATCH_ACTIONS = CONTROL_COMMANDS;
export type DispatchAction = (typeof DISPATCH_ACTIONS)[number];

/**
 * Where a scoped command applies: the next iteration boundary, the default,
 * or the next boundary of either kind. Only pause and stop take one from here.
 */
export const CONTROL_SCOPES = ["iteration", "phase"] as const;
export type ControlScope = (typeof CONTROL_SCOPES)[number];
export const SCOPED_ACTIONS: readonly DispatchAction[] = ["pause", "stop"];

/**
 * A command id the inbox can name a file after. The poller holds the same
 * rule; an id outside it is refused rather than escaped, because two ids that
 * escaped to one name would let the second overwrite the first while pending.
 */
export const isSafeCommandId = (id: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.endsWith(".tmp");

/**
 * `project-config`'s loop-name shape, restated for one purpose: a name must be
 * a single path segment and argv word before it reaches `worktreeFor` or a
 * branch name. Whether the roster accepts it is still `project-config`'s call.
 */
export const LOOP_NAME_SHAPE = /^[a-z][a-z0-9]*$/;

export interface DispatchRequest {
  /** The loop the operator addressed. Must be the loop this dispatcher serves. */
  loop: string;
  action: DispatchAction;
  /** The Ralph run the operator named, or null/absent for "whoever holds it". */
  run?: string | null;
  why?: string | null;
  stopKind?: StopKind | null;
  /** The ticket `abandon` and `release` act on. Required for them, refused for the rest. */
  issue?: number | null;
  /** The operator re-issuing a command they know names a replaced run. */
  reconfirm?: boolean;
  /** Where a pause or stop applies: the next iteration (the default) or the next phase. */
  scope?: ControlScope | null;
  /** The phase a gate is armed or disarmed before. Required for them, refused for the rest. */
  phase?: Phase | null;
  /** The idempotency key; generated when absent, so a re-send is a replay. */
  id?: string | null;
  /** Who sent it when it was not the local operator; written into the command file. */
  via?: string | null;
}

export interface StartRequest {
  loop: string;
}

export interface ResumeWorkRequest {
  loop: string;
}

export interface RestartRequest {
  loop: string;
  /** The run the operator means to stop; defaults to the loop's observed run. */
  run?: string | null;
  why?: string | null;
  stopKind?: StopKind | null;
  reconfirm?: boolean;
  /** The idempotency key for the stop; re-issuing it resumes the wait. */
  id?: string | null;
  /** Who asked when it was not the local operator; carried on the stop's command file. */
  via?: string | null;
}

export interface StopNowRequest {
  loop: string;
  /** The operator's reason, kept in the audit file and on the recorded stop. */
  why?: string | null;
  /** The run the operator was looking at; absent means whoever holds the loop. */
  run?: string | null;
  reconfirm?: boolean;
  /** The idempotency key; generated when absent. */
  id?: string | null;
  /** Who asked when it was not the local operator; on every audit line, so History shows it. */
  via?: string | null;
}

/** A mark-read request: the loop, and the newest alert time the operator has seen. */
export interface MarkReadRequest {
  loop: string;
  through: string;
}

/**
 * A request the route answers with a client error; `name` is the distinct error kind.
 *
 * Every parser below throws it, so the local routes and the remote function
 * answer with the same error kinds and body shape.
 */
export class ControlRouteError extends Error {
  constructor(
    readonly status: number,
    name: string,
    message: string,
  ) {
    super(message);
    this.name = name;
  }
}

export const invalid = (message: string): ControlRouteError =>
  new ControlRouteError(400, "ControlRequestError", message);

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// Restated rather than imported from `./adapter`, which would pull the adapters' graph in.
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const optionalText = (body: Record<string, unknown>, name: string): string | null => {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid(`'${name}' must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

export const optionalFlag = (body: Record<string, unknown>, name: string): boolean | undefined => {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw invalid(`'${name}' must be true or false`);
  return value;
};

/**
 * The optional `via`, only when given: it names the writer when it is not the
 * local operator (the remote relay sends `"remote"`), and History shows it. A
 * request without one parses exactly as before.
 */
export const withVia = (body: Record<string, unknown>): { via?: string } => {
  const via = optionalText(body, "via");
  return via === null ? {} : { via };
};

/** The destructive actions, and what each would do to a misclick. */
export const CONFIRMATION_REQUIRED: Partial<Record<DispatchAction, string>> = {
  stop: "stop ends the loop at its next iteration boundary, or its next phase boundary with scope phase",
  abandon: "abandon takes an expired claim back from its owner",
  release: "release gives up the run's claim on the ticket",
};

/**
 * Validate one control request into the dispatch request it names.
 *
 * Only shape is judged here. Run ownership, replay and approval semantics are
 * the channel's, and are reached through dispatch rather than restated.
 */
export function parseControlRequest(body: unknown): DispatchRequest {
  if (!isObject(body)) throw invalid("the request body must be a JSON object");
  const loop = optionalText(body, "loop");
  if (loop === null) throw invalid("'loop' is required: name the loop the command is for");
  const action = optionalText(body, "action");
  if (action === null) throw invalid(`'action' is required: one of ${DISPATCH_ACTIONS.join(", ")}`);
  if (!(DISPATCH_ACTIONS as readonly string[]).includes(action)) {
    throw invalid(`unknown control action '${action}'; expected one of ${DISPATCH_ACTIONS.join(", ")}`);
  }
  const stopKind = optionalText(body, "stopKind");
  if (stopKind !== null) {
    if (action !== "stop") throw invalid("'stopKind' applies only to stop");
    if (!(ORDERLY_STOP_KINDS as readonly string[]).includes(stopKind)) {
      throw invalid(`unknown stop kind '${stopKind}'; expected one of ${ORDERLY_STOP_KINDS.join(", ")}`);
    }
  }
  const scope = optionalText(body, "scope");
  if (scope !== null) {
    if (!(CONTROL_SCOPES as readonly string[]).includes(scope)) {
      throw invalid(`unknown scope '${scope}'; expected one of ${CONTROL_SCOPES.join(", ")}`);
    }
    if (!SCOPED_ACTIONS.includes(action as DispatchAction)) {
      throw invalid(`'scope' applies only to ${SCOPED_ACTIONS.join(" and ")}`);
    }
  }
  // Only the value is judged here; which actions take a phase is dispatch's.
  const phase = optionalText(body, "phase");
  if (phase !== null && !(PHASES as readonly string[]).includes(phase)) {
    throw invalid(`unknown phase '${phase}'; expected one of ${PHASES.join(", ")}`);
  }
  const reconfirm = optionalFlag(body, "reconfirm");
  // Only the type is judged here; which actions take a ticket is dispatch's.
  const issue = body.issue ?? null;
  if (issue !== null && typeof issue !== "number") throw invalid("'issue' must be a positive whole number");
  const unconfirmed = CONFIRMATION_REQUIRED[action as DispatchAction];
  if (unconfirmed !== undefined && body.confirm !== true) {
    throw new ControlRouteError(400, "ConfirmationRequired", `${unconfirmed}: send it with "confirm": true`);
  }
  return {
    loop,
    action: action as DispatchAction,
    run: optionalText(body, "run"),
    why: optionalText(body, "why"),
    stopKind: stopKind as StopKind | null,
    issue: issue as number | null,
    reconfirm: reconfirm === true,
    scope: scope as ControlScope | null,
    phase: phase as Phase | null,
    id: optionalText(body, "id"),
    ...withVia(body),
  };
}

/**
 * The JSON-text step of reading a body, on its own so the remote function can
 * judge text it has already read with the same 400 the local routes answer.
 */
export function parseJsonBody(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw invalid("the request body is not valid JSON");
  }
}

export async function readBody(request: Request): Promise<unknown> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    throw invalid("could not read the request body");
  }
  return parseJsonBody(raw);
}

const requireLoop = (body: unknown): { body: Record<string, unknown>; loop: string } => {
  if (!isObject(body)) throw invalid("the request body must be a JSON object");
  const loop = optionalText(body, "loop");
  if (loop === null) throw invalid("'loop' is required: name the loop to act on");
  return { body, loop };
};

/** Validate a start request. Start is idempotent, so it asks for no confirmation. */
export function parseStartRequest(raw: unknown): StartRequest {
  return { loop: requireLoop(raw).loop };
}

/**
 * Validate a restart request into the lifecycle request it names.
 *
 * Only shape is judged here. Whether the stop is confirmed, whether the
 * supervisor has gone, and whether an old stop still stands are lifecycle
 * dispatch's to read from the records, and are not restated.
 */
export function parseRestartRequest(raw: unknown): RestartRequest {
  const { body, loop } = requireLoop(raw);
  const stopKind = optionalText(body, "stopKind");
  if (stopKind !== null && !(ORDERLY_STOP_KINDS as readonly string[]).includes(stopKind)) {
    throw invalid(`unknown stop kind '${stopKind}'; expected one of ${ORDERLY_STOP_KINDS.join(", ")}`);
  }
  const reconfirm = optionalFlag(body, "reconfirm");
  if (body.confirm !== true) {
    throw new ControlRouteError(
      400,
      "ConfirmationRequired",
      'restart stops the loop at its next iteration boundary and starts it again: send it with "confirm": true',
    );
  }
  return {
    loop,
    run: optionalText(body, "run"),
    why: optionalText(body, "why"),
    stopKind: stopKind as StopKind | null,
    reconfirm: reconfirm === true,
    id: optionalText(body, "id"),
    ...withVia(body),
  };
}

/** Validate a Resume work request. Like start, it asks for no confirmation. */
export function parseResumeWorkRequest(raw: unknown): ResumeWorkRequest {
  return { loop: requireLoop(raw).loop };
}

/**
 * Validate a Stop now request. The confirmation is the server's to enforce: a
 * misclick or a hand-written `curl` must not signal a loop.
 */
export function parseStopNowRequest(raw: unknown): StopNowRequest {
  const { body, loop } = requireLoop(raw);
  const reconfirm = optionalFlag(body, "reconfirm");
  const id = optionalText(body, "id");
  if (id !== null && !isSafeCommandId(id)) {
    throw invalid("'id' must be letters, numbers, '.', '_' or '-' (at most 128, not starting with a dot)");
  }
  if (body.confirm !== true) {
    throw new ControlRouteError(
      400,
      "ConfirmationRequired",
      'stop now signals the loop\'s process group and ends the iteration in progress: send it with "confirm": true',
    );
  }
  return { loop, why: optionalText(body, "why"), run: optionalText(body, "run"), reconfirm: reconfirm === true, id, ...withVia(body) };
}

/** Validate a mark-read request: the loop, and the newest alert seen, normalized to ISO. */
export function parseMarkRead(body: unknown): MarkReadRequest {
  if (!isObject(body)) throw invalid("the request body must be a JSON object");
  const loop = optionalText(body, "loop");
  if (loop === null) throw invalid("'loop' is required: name the loop whose alerts to mark read");
  const through = optionalText(body, "through");
  if (through === null || Number.isNaN(Date.parse(through))) {
    throw invalid("'through' is required: the time of the newest alert the operator has seen, as an ISO timestamp");
  }
  return { loop, through: new Date(through).toISOString() };
}

/**
 * The agent's name, as a request must carry it. Only its shape is judged here
 * — enough to be a path segment and an argv word; whether the roster accepts
 * it is `project-config`'s answer, returned as a refusal.
 */
export function parseAgentName(raw: unknown): { body: Record<string, unknown>; name: string } {
  if (!isObject(raw)) throw invalid("the request body must be a JSON object");
  const name = optionalText(raw, "name");
  if (name === null) throw invalid("'name' is required: name the agent");
  if (!LOOP_NAME_SHAPE.test(name)) throw invalid(`'name' must be one lowercase word (a-z, then a-z or 0-9); got '${name}'`);
  return { body: raw, name };
}

/**
 * At most this many bytes of plan: a page-built plan is a few hundred. Under
 * the hosted store's 4 KB command body, so a plan the local page sends is one
 * the remote page can send too.
 */
const EVAL_PLAN_MAX_BYTES = 3_500;

/** A clerk's name as a plan names it: lowercase kebab-case, like the roster's. */
const CLERK_NAME_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * An eval run's plan (#801), as the Run screen sends it. Only its shape is
 * judged here: an object, of a sane size, that is a PR plan (a `source` of
 * kind "pr"), a test set plan (#854: a `source` of kind "set", with optional
 * `tags` and `cases` filters) or a clerk plan (#827: no `source`, a `clerk`
 * and the `sample` of its tickets to replay). Whether it would run is
 * `experiments.ts start`'s answer, returned as a refusal.
 */
export function parseEvalStart(raw: unknown): { plan: Record<string, unknown> } {
  if (!isObject(raw)) throw invalid("the request body must be a JSON object");
  return { plan: requirePlan(raw) };
}

/** The body's `plan`, judged as `parseEvalStart` judges it: a start and an inbox add (#872) take the same plans. */
function requirePlan(raw: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(raw.plan)) throw invalid("'plan' is required: the eval plan, a JSON object");
  if (JSON.stringify(raw.plan).length > EVAL_PLAN_MAX_BYTES) throw invalid(`'plan' is over ${EVAL_PLAN_MAX_BYTES} bytes`);
  const plan = raw.plan;
  const hasClerk = "clerk" in plan;
  const hasSample = "sample" in plan;
  if (plan.source !== undefined && plan.source !== null) {
    // A plan names one source: the harness would not know which to replay.
    if (hasClerk || hasSample) throw invalid("'plan' names both a 'source' and a 'clerk'/'sample': a PR or test set plan carries neither 'clerk' nor 'sample'");
    const source = plan.source;
    if (isObject(source) && source.kind === "set") {
      for (const field of ["tags", "cases"] as const) {
        const value = source[field];
        if (value !== undefined && (!Array.isArray(value) || !value.every((item) => typeof item === "string"))) {
          throw invalid(`'plan.source.${field}' must be a list of strings when given; got ${JSON.stringify(value)}`);
        }
      }
      return plan;
    }
    if (!isObject(source) || source.kind !== "pr") {
      throw invalid("'plan.source' must be a PR source ({ kind: \"pr\", prs: [...] }) or a test set source ({ kind: \"set\", tags?: [...], cases?: [...] })");
    }
    return plan;
  }
  if (!hasClerk) throw invalid("'plan' needs a source: a PR source ({ kind: \"pr\", prs: [...] }), a test set source ({ kind: \"set\", ... }) or a 'clerk' with a 'sample'");
  if (typeof plan.clerk !== "string" || !CLERK_NAME_SHAPE.test(plan.clerk)) {
    throw invalid(`'plan.clerk' must be a clerk's name in lowercase kebab-case; got ${JSON.stringify(plan.clerk)}`);
  }
  const sample = plan.sample;
  if (!isObject(sample)) throw invalid("'plan.sample' is required with a clerk: { cap: <tickets>, since?: <ISO time> }");
  if (typeof sample.cap !== "number" || !Number.isSafeInteger(sample.cap) || sample.cap < 1) {
    throw invalid(`'plan.sample.cap' must be a positive whole number of tickets; got ${JSON.stringify(sample.cap)}`);
  }
  if (sample.since !== undefined && sample.since !== null && typeof sample.since !== "string") {
    throw invalid("'plan.sample.since' must be a time as a string when given");
  }
  return plan;
}

/** The run to stop: its directory's name, one path segment. */
export function parseEvalStop(raw: unknown): { run: string } {
  if (!isObject(raw)) throw invalid("the request body must be a JSON object");
  const run = optionalText(raw, "run");
  if (run === null) throw invalid("'run' is required: the run's id");
  if (!/^[\w.-]+$/.test(run) || run.startsWith(".")) throw invalid(`'run' must be a run's id; got '${run}'`);
  return { run };
}

/** A test-set case's id, as the store names it: lowercase kebab-case. */
export const EVAL_CASE_ID_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A GitHub repository as `owner/name`. */
const EVAL_REPO_SHAPE = /^[\w.-]+\/[\w.-]+$/;
/**
 * Bounds on a curation body. The remote relay refuses a command body over
 * 4 KB on its own (413), so a long note can only be written from the local
 * page; these bounds keep the local route from committing an unbounded file.
 */
const EVAL_SET_MAX_PRS = 20;
const EVAL_SET_MAX_TAGS = 20;
const EVAL_SET_TAG_MAX_CHARS = 64;
const EVAL_SET_TEXT_MAX_CHARS = 4_000;

/**
 * The case a curation command names, under `case`, not `id`: the remote
 * relay stamps every body's `id` with its own idempotency key (a UUID, which
 * the case shape would accept), so a case id there would be overwritten.
 */
function requireCaseId(body: Record<string, unknown>): string {
  const id = optionalText(body, "case");
  if (id === null) throw invalid("'case' is required: the test-set case's id");
  if (!EVAL_CASE_ID_SHAPE.test(id)) throw invalid(`'case' must be a case id in lowercase kebab-case; got '${id}'`);
  return id;
}

/** Tags when given: at most 20 non-empty strings of at most 64 characters, trimmed. */
function optionalTags(body: Record<string, unknown>): string[] | undefined {
  const tags = body.tags;
  if (tags === undefined || tags === null) return undefined;
  if (!Array.isArray(tags)) throw invalid("'tags' must be a list of strings");
  if (tags.length > EVAL_SET_MAX_TAGS) throw invalid(`'tags' holds at most ${EVAL_SET_MAX_TAGS} tags; got ${tags.length}`);
  return tags.map((tag) => {
    if (typeof tag !== "string" || tag.trim() === "") throw invalid("each tag must be a non-empty string");
    if (tag.trim().length > EVAL_SET_TAG_MAX_CHARS) throw invalid(`each tag is at most ${EVAL_SET_TAG_MAX_CHARS} characters`);
    // The page edits tags as comma-separated text, so a comma inside one would split it on the next edit.
    if (tag.includes(",")) throw invalid("a tag may not contain a comma");
    return tag.trim();
  });
}

/** A free-text field when given, trimmed; an empty string is kept, since it clears the notes. */
function optionalLongText(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalid(`'${name}' must be a string`);
  if (value.length > EVAL_SET_TEXT_MAX_CHARS) throw invalid(`'${name}' is at most ${EVAL_SET_TEXT_MAX_CHARS} characters`);
  return value.trim();
}

/**
 * Add a case to the test set (#856): a repository, the PRs that make the
 * case, and why it belongs. Whether those PRs exist and make a case is
 * `evals-set.ts add`'s answer, returned as a refusal.
 */
export function parseEvalSetAdd(raw: unknown): { repo: string; prs: number[]; reason: string; tags?: string[]; notes?: string } {
  if (!isObject(raw)) throw invalid("the request body must be a JSON object");
  const repo = optionalText(raw, "repo");
  if (repo === null) throw invalid("'repo' is required: the repository, as owner/name");
  if (!EVAL_REPO_SHAPE.test(repo)) throw invalid(`'repo' must be owner/name; got '${repo}'`);
  const prs = raw.prs;
  if (!Array.isArray(prs) || prs.length === 0) throw invalid("'prs' is required: a list of at least one PR number");
  if (prs.length > EVAL_SET_MAX_PRS) throw invalid(`'prs' holds at most ${EVAL_SET_MAX_PRS} PRs; got ${prs.length}`);
  for (const pr of prs) {
    if (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr < 1) throw invalid(`each PR must be a positive whole number; got ${JSON.stringify(pr)}`);
  }
  const reason = optionalLongText(raw, "reason");
  if (reason === undefined || reason === "") throw invalid("'reason' is required: why this case belongs in the set");
  const tags = optionalTags(raw);
  const notes = optionalLongText(raw, "notes");
  return { repo, prs: prs as number[], reason, ...(tags === undefined ? {} : { tags }), ...(notes === undefined ? {} : { notes }) };
}

/** Edit a case's tags or notes (#856); at least one, since an empty edit writes nothing. */
export function parseEvalSetEdit(raw: unknown): { case: string; tags?: string[]; notes?: string } {
  if (!isObject(raw)) throw invalid("the request body must be a JSON object");
  const id = requireCaseId(raw);
  const tags = optionalTags(raw);
  const notes = optionalLongText(raw, "notes");
  if (tags === undefined && notes === undefined) throw invalid("an edit needs 'tags' or 'notes'");
  return { case: id, ...(tags === undefined ? {} : { tags }), ...(notes === undefined ? {} : { notes }) };
}

/** Retire a case (#856): it stays in the set's history but no run samples it. */
export function parseEvalSetRetire(raw: unknown): { case: string } {
  if (!isObject(raw)) throw invalid("the request body must be a JSON object");
  return { case: requireCaseId(raw) };
}

/** Keep a saturated case (#860): it stays active, and its saturation counts only the set runs after now. */
export function parseEvalSetKeep(raw: unknown): { case: string } {
  return parseEvalSetRetire(raw);
}

/** Bounds on a check's text: a test path, and a shell command, each well inside the relay's 4 KB body. */
const EVAL_CHECK_TEST_MAX_CHARS = 500;
const EVAL_CHECK_COMMAND_MAX_CHARS = 2_000;

/**
 * Attach an operator check to a case (#857): exactly one of a test path in the
 * case's repo or a shell command. Whether it fails on the base and passes on
 * the reference is `evals-set.ts check`'s answer, returned as a refusal.
 */
export function parseEvalSetCheck(raw: unknown): { case: string; test: string } | { case: string; command: string } {
  if (!isObject(raw)) throw invalid("the request body must be a JSON object");
  const id = requireCaseId(raw);
  const test = optionalText(raw, "test");
  const command = optionalText(raw, "command");
  if ((test === null) === (command === null)) throw invalid("a check needs exactly one of 'test' (a test file's path) or 'command' (a shell command)");
  // The CLI reads a value that starts with -- as a missing value, so it is refused here as the body's fault.
  if (test !== null) {
    if (test.length > EVAL_CHECK_TEST_MAX_CHARS) throw invalid(`'test' is at most ${EVAL_CHECK_TEST_MAX_CHARS} characters`);
    if (test.startsWith("--")) throw invalid("'test' may not start with --");
    // The stored check refuses the same: a path outside the case's repo would run something the case never held.
    if (test.startsWith("/") || test.split(/[\\/]/).includes("..")) throw invalid(`'test' must be a relative path with no .. segment; got '${test}'`);
    return { case: id, test };
  }
  if (command!.length > EVAL_CHECK_COMMAND_MAX_CHARS) throw invalid(`'command' is at most ${EVAL_CHECK_COMMAND_MAX_CHARS} characters`);
  if (command!.startsWith("--")) throw invalid("'command' may not start with --");
  return { case: id, command: command! };
}

/** An arm's name as a lineup names it (`opus`, `codex-high`): short, and never flag-like, since it becomes a CLI argument. The reason shares set-add's bound, so a reason near it can still pass the relay's 4 KB body cap and be refused remotely. */
const EVAL_ARM_NAME_SHAPE = /^[\w.-]{1,64}$/;

/**
 * An operator's calibration verdict on a case (#876): which of two distinct
 * arms was better on one axis the panel scores, and why. Whether the case
 * exists is `evals-set.ts calibrate`'s answer, returned as a refusal.
 */
export function parseEvalSetCalibrate(raw: unknown): { case: string; arms: [string, string]; axis: EvalAxis; preferred: string; reason: string } {
  if (!isObject(raw)) throw invalid("the request body must be a JSON object");
  const id = requireCaseId(raw);
  const arms = raw.arms;
  if (!Array.isArray(arms) || arms.length !== 2) throw invalid("'arms' is required: exactly two arm names");
  for (const arm of arms) {
    if (typeof arm !== "string" || arm.trim() === "") throw invalid("'arms' must be two non-empty arm names");
    // The shape also refuses a leading --, which the CLI would read as a missing value.
    if (!EVAL_ARM_NAME_SHAPE.test(arm) || arm.startsWith("-")) throw invalid(`'arms' must be arm names of letters, digits, '.', '_' or '-', at most 64 characters; got '${arm}'`);
  }
  const [first, second] = arms as [string, string];
  if (first === second) throw invalid("'arms' must be two different arms");
  const axis = raw.axis;
  if (!EVAL_AXES.includes(axis as EvalAxis)) throw invalid(`'axis' must be one of ${EVAL_AXES.join(", ")}`);
  if (raw.preferred !== first && raw.preferred !== second) throw invalid(`'preferred' must be one of the arms, ${first} or ${second}`);
  const reason = optionalLongText(raw, "reason");
  if (reason === undefined || reason === "") throw invalid("'reason' is required: why that arm was better");
  if (reason.startsWith("--")) throw invalid("'reason' may not start with --");
  return { case: id, arms: [first, second], axis: axis as EvalAxis, preferred: raw.preferred as string, reason };
}

/** At most this many characters of an inbox reason: a sentence or two. */
const EVAL_INBOX_REASON_MAX_CHARS = 500;
/** An inbox entry's id as `eval-inbox.ts` makes it (`rec-1a2b3c4d`), bounded. */
export const EVAL_INBOX_ID_SHAPE = /^[a-z0-9-]{1,64}$/;

/**
 * A plan recommended into the inbox (#872): the plan judged as a start judges
 * it, and an optional reason, trimmed; an empty one is absent and the adapter
 * gives the default. Whether the plan would run is `evals-inbox.ts add`'s
 * answer, returned as a refusal.
 */
export function parseEvalInboxAdd(raw: unknown): { plan: Record<string, unknown>; reason?: string } {
  if (!isObject(raw)) throw invalid("the request body must be a JSON object");
  const plan = requirePlan(raw);
  const reason = optionalText(raw, "reason");
  if (reason === null) return { plan };
  if (reason.length > EVAL_INBOX_REASON_MAX_CHARS) throw invalid(`'reason' is at most ${EVAL_INBOX_REASON_MAX_CHARS} characters`);
  // The CLI reads a value that starts with -- as a missing value, so it is refused here as the body's fault.
  if (reason.startsWith("--")) throw invalid("'reason' may not start with --");
  // The plan and the reason share the relay's 4 KB body: a plan near its own
  // bound leaves no room for a long reason, so the two are bounded together.
  if (new TextEncoder().encode(JSON.stringify({ plan, reason })).length > EVAL_PLAN_MAX_BYTES) {
    throw invalid(`'plan' and 'reason' together are over ${EVAL_PLAN_MAX_BYTES} bytes; shorten the reason`);
  }
  return { plan, reason };
}

/**
 * The inbox entry a start or dismiss names (#872), under `entry`, not `id`:
 * the remote relay stamps every body's `id` with its own idempotency key, as
 * `requireCaseId` explains for a test-set case.
 */
export function parseEvalInboxEntry(raw: unknown): { entry: string } {
  if (!isObject(raw)) throw invalid("the request body must be a JSON object");
  const entry = optionalText(raw, "entry");
  if (entry === null) throw invalid("'entry' is required: the inbox entry's id");
  if (!EVAL_INBOX_ID_SHAPE.test(entry)) throw invalid(`'entry' must be an inbox entry's id; got '${entry}'`);
  return { entry };
}

/** An eval run's id, one kebab path segment (`eval-…`, `backtest-…`, `nightly-…`), bounded; the CLI holds it to `segment` in `backtest-run.ts`, not imported. */
export const EVAL_RUN_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,79}$/;
/** The goals the improver (#873) proposes toward, mirrored from `eval-improver.ts`'s GOALS, not imported. */
export const EVAL_IMPROVE_GOALS = ["quality", "cost"] as const;

/**
 * The finished run the improver reads and the goal it proposes toward (#873).
 * The run is under `run`, as a stop names it: the relay stamps `id`. Whether
 * the run has a report and an analysis is `evals-improve.ts propose`'s
 * answer, returned as a refusal.
 */
export function parseEvalImprovePropose(raw: unknown): { run: string; goal: (typeof EVAL_IMPROVE_GOALS)[number] } {
  if (!isObject(raw)) throw invalid("the request body must be a JSON object");
  const run = optionalText(raw, "run");
  if (run === null) throw invalid("'run' is required: the finished eval run's id");
  if (!EVAL_RUN_ID_SHAPE.test(run)) throw invalid(`'run' must be an eval run's id; got '${run}'`);
  const goal = raw.goal;
  if (!(EVAL_IMPROVE_GOALS as readonly unknown[]).includes(goal)) {
    throw invalid(`'goal' must be one of ${EVAL_IMPROVE_GOALS.join(", ")}; got ${JSON.stringify(goal)}`);
  }
  return { run, goal: goal as (typeof EVAL_IMPROVE_GOALS)[number] };
}

/** Each relayed command's parser: the one the local route answers its body with. */
export const COMMAND_PARSERS: Record<RelayedCommandKind, (body: unknown) => unknown> = {
  control: parseControlRequest,
  start: parseStartRequest,
  restart: parseRestartRequest,
  "stop-now": parseStopNowRequest,
  "resume-work": parseResumeWorkRequest,
  "agent-start": parseAgentName,
  "mark-read": parseMarkRead,
  "eval-start": parseEvalStart,
  "eval-stop": parseEvalStop,
  "eval-set-add": parseEvalSetAdd,
  "eval-set-edit": parseEvalSetEdit,
  "eval-set-retire": parseEvalSetRetire,
  "eval-set-check": parseEvalSetCheck,
  "eval-set-keep": parseEvalSetKeep,
  "eval-inbox-add": parseEvalInboxAdd,
  "eval-inbox-start": parseEvalInboxEntry,
  "eval-inbox-dismiss": parseEvalInboxEntry,
  "eval-improve-propose": parseEvalImprovePropose,
  "eval-set-calibrate": parseEvalSetCalibrate,
  "eval-proposal-open-pr": parseEvalProposalOpenPr,
};

/** An improver proposal's id as `evals-improve.ts` makes it (`prop-1a2b3c4d`); it becomes a CLI argument, so nothing else passes. */
export const EVAL_PROPOSAL_ID_SHAPE = /^prop-[0-9a-f]{8}$/;

/**
 * Open the PR a passed proposal stands for (#875). The proposal is under
 * `proposal`, since the relay stamps `id`. Whether it passed is
 * `evals-proposals.ts open-pr`'s answer, recomputed there and returned as a
 * refusal: the page's word that it passed is never trusted.
 */
export function parseEvalProposalOpenPr(raw: unknown): { proposal: string } {
  if (!isObject(raw)) throw invalid("the request body must be a JSON object");
  const proposal = optionalText(raw, "proposal");
  if (proposal === null) throw invalid("'proposal' is required: the improver proposal's id");
  if (!EVAL_PROPOSAL_ID_SHAPE.test(proposal)) throw invalid(`'proposal' must be an improver proposal's id; got '${proposal}'`);
  return { proposal };
}

/** Throw the 400 the local route would answer `body` with; return when it is well-formed. */
export function checkCommandBody(kind: RelayedCommandKind, body: unknown): void {
  COMMAND_PARSERS[kind](body);
}
