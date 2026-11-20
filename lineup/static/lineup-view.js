/**
 * The lineup editor page's pure view helpers and its HTTP client.
 *
 * Plain JavaScript served as-is, so the page has no build step; the page
 * imports it as a native module and the Vitest suites import it through
 * `lineup-view.d.ts`. It touches no DOM, so everything here is testable.
 *
 * It knows the editor's HTTP view models and nothing below them. The runners a
 * stage offers, the Agent-tool alias set, which stages are Agent-tool calls and
 * the model-id rules all come from the `schema` the read response carries —
 * never from a list kept here, which is how a form and its validator drift
 * apart. The checks below are a courtesy before a round trip; the server's
 * validator stays the only authority on save.
 */

export const DEFAULT_LOOP = "default";

/** The runner on which an Agent-tool stage is the in-session Agent call itself. */
const AGENT_TOOL_RUNNER = "claude";

/** Older schemas only offered orchestrator effort. */
const EFFORT_STAGE = "orchestrator";

export const APPLY_TIMING =
  "A save rewrites models.json and nothing else. The supervisor resolves its lineup once, at startup, " +
  "so a saved change applies at the next `start.sh` — a running supervisor keeps the lineup it started with.";

const LINEUP = "/api/lineup";
const PREVIEW = "/api/lineup/preview";
const EDIT = "/api/lineup/edit";
const SAVE = "/api/lineup/save";
const ROOTS = "/api/roots";

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** `review.standards` lives at `block.review.standards`. */
function stageNode(block, stage) {
  let node = block;
  for (const part of stage.split(".")) {
    if (!isRecord(node)) return undefined;
    node = node[part];
  }
  return isRecord(node) ? node : undefined;
}

/**
 * Every loop the page lists: `default` first, then each block the file names
 * (commentary keys skipped), then any loop the page already knows — so a loop
 * whose block was just removed stays on the list, running `default`.
 */
export function loopNames(config, extra = []) {
  const names = [DEFAULT_LOOP];
  // `$` keys are commentary and `@` keys are a ROLE's default lineup
  // (`@triager`) — the resolver's namespace, not a loop. A role default listed
  // as a loop would be offered a form for the wrong stage set, under a name no
  // loop has.
  const add = (name) => {
    if (typeof name !== "string" || name === "" || name.startsWith("$") || name.startsWith("@") || names.includes(name)) return;
    names.push(name);
  };
  Object.keys(config).forEach(add);
  extra.forEach(add);
  return names;
}

export function hasBlock(config, loop) {
  return isRecord(config[loop]);
}

/** One stage's fields exactly as the file has them, or null when the loop has no such stage. */
export function stageValues(config, loop, stage) {
  const block = config[loop];
  if (!isRecord(block)) return null;
  const node = stageNode(block, stage);
  if (node === undefined) return null;
  const values = {};
  for (const key of ["runner", "model", "effort"]) {
    if (typeof node[key] === "string") values[key] = node[key];
  }
  if (Array.isArray(node.fallback) && node.fallback.every((value) => typeof value === "string")) {
    values.fallback = [...node.fallback];
  } else if (typeof node.fallback === "string") {
    values.fallback = [node.fallback];
  }
  return values;
}

/** The form's starting state: the loop's own stage, else `default`'s, which is what it runs. */
export function draftFor(config, loop, stage) {
  const values = stageValues(config, loop, stage) ?? stageValues(config, DEFAULT_LOOP, stage) ?? {};
  return {
    runner: values.runner ?? "",
    model: values.model ?? "",
    effort: values.effort ?? "",
    fallback: values.fallback ?? [],
  };
}

/**
 * Whether the stage on this runner is a named Claude agent, which takes a full
 * id with the schema's `claudeIdPrefix` as well as an alias. An older schema
 * has neither field: its Agent-tool stages were ad-hoc calls, alias only.
 */
function isNamedAgent(schema, stage, runner) {
  return runner === AGENT_TOOL_RUNNER && schema.agentNames?.[stage] !== undefined && schema.claudeIdPrefix !== undefined;
}

export function stageControls(schema, stage, runner) {
  const agentTool = schema.agentToolStages.includes(stage);
  return {
    runners: [...(schema.runnersFor[stage] ?? [])],
    effort: schema.effortRunnersFor?.[stage]?.includes(runner) ?? stage === EFFORT_STAGE,
    // A fallback is where a non-Agent-tool run degrades to the Agent call; on
    // the Agent-tool runner the stage already is that call.
    fallback: agentTool && runner !== AGENT_TOOL_RUNNER,
    modelChoices: agentTool && runner === AGENT_TOOL_RUNNER && !isNamedAgent(schema, stage, runner) ? [...schema.aliases] : null,
    fallbackChoices: [...schema.aliases],
    defaultFallback: schema.defaultFallback,
    defaultFallbacks: [...(schema.defaultFallbacks ?? [schema.defaultFallback])],
  };
}

/** Why `model` cannot be this stage's model on `runner`, in the resolver's words, or null. */
export function modelProblem(schema, stage, runner, model) {
  const id = model.trim();
  const field = `'${stage}.model'`;
  if (id === "") return `${field} must be a non-empty string.`;
  if (!new RegExp(schema.modelId.pattern).test(id)) {
    return `${field} has characters a model id cannot: ${JSON.stringify(id)}.`;
  }
  const aliases = schema.aliases;
  if (isNamedAgent(schema, stage, runner)) {
    if (aliases.includes(id) || (id.startsWith(schema.claudeIdPrefix) && !id.includes("/"))) return null;
    return (
      `${field} is '${id}', but on the '${runner}' runner that stage is a named Claude agent, whose model is one of: ` +
      `${aliases.join(", ")}, or a full '${schema.claudeIdPrefix}…' id.`
    );
  }
  if (schema.agentToolStages.includes(stage) && runner === AGENT_TOOL_RUNNER) {
    if (aliases.includes(id)) return null;
    return (
      `${field} is '${id}', but on the '${runner}' runner that stage is an Agent call, whose model is one of: ` +
      `${aliases.join(", ")}. A full id is refused there — give it a runner that takes one.`
    );
  }
  if (runner !== AGENT_TOOL_RUNNER && aliases.includes(id)) {
    return (
      `${field} is '${id}', which is one of the Agent tool's aliases — it means nothing to the ` +
      `'${runner}' runner. Name a model that runner has.`
    );
  }
  const prefix = schema.modelId.providerPrefix[runner];
  if (prefix === "required" && !id.includes("/")) {
    return `${field} is '${id}', but ${runner} names a model 'provider/model'.`;
  }
  if (prefix === "forbidden" && id.includes("/")) {
    return `${field} is '${id}', but ${runner} names a model without a provider prefix.`;
  }
  return null;
}

function fallbackRunner(schema, model) {
  if (schema.aliases.includes(model) || model.startsWith("claude-")) return AGENT_TOOL_RUNNER;
  const prefix = model.includes("/") ? "required" : "forbidden";
  return schema.runners.find((runner) => schema.modelId.providerPrefix[runner] === prefix) ?? "";
}

/** Every problem the form can see in a draft, not just the first. */
export function draftProblems(schema, stage, draft) {
  const problems = [];
  const controls = stageControls(schema, stage, draft.runner);
  if (!controls.runners.includes(draft.runner)) {
    problems.push(
      `'${stage}.runner' is '${draft.runner}', which cannot run '${stage}'. ` +
        `That stage runs on: ${controls.runners.join(", ")}.`,
    );
  } else {
    const model = modelProblem(schema, stage, draft.runner, draft.model);
    if (model !== null) problems.push(model);
  }
  if (controls.fallback) {
    const seen = new Set();
    for (const fallback of draft.fallback) {
      const route = fallbackRunner(schema, fallback);
      // A Claude fallback is an ad-hoc Agent call, never the named agent, so
      // it takes an alias only even where the stage's own model may be an id.
      const problem = route === AGENT_TOOL_RUNNER && !schema.aliases.includes(fallback)
        ? `'${stage}.fallback' is '${fallback}', but a Claude fallback is an Agent call, whose model is one of: ` +
          `${schema.aliases.join(", ")}.`
        : modelProblem(schema, stage, route, fallback);
      if (problem !== null) problems.push(problem.replace(`'${stage}.model'`, `'${stage}.fallback'`));
      if (seen.has(fallback)) problems.push(`'${stage}.fallback' repeats ${JSON.stringify(fallback)}.`);
      seen.add(fallback);
      if (route === draft.runner && fallback === draft.model.trim()) {
        problems.push(`'${stage}.fallback' repeats its primary route ${JSON.stringify(fallback)}.`);
      }
    }
  }
  return problems;
}

/**
 * The one change an Apply sends: runner and model together, so switching a
 * stage's harness never leaves the old model stranded on it. A field the
 * stage cannot carry on that runner is cleared rather than left to be refused.
 */
export function buildChange(schema, stage, draft) {
  const controls = stageControls(schema, stage, draft.runner);
  const effort = draft.effort.trim();
  const fallback = draft.fallback.map((value) => value.trim()).filter(Boolean);
  return {
    runner: draft.runner.trim(),
    model: draft.model.trim(),
    effort: controls.effort && effort !== "" ? effort : null,
    fallback: controls.fallback && fallback.length > 0 ? fallback : null,
  };
}

/** The resolved lineup as rows, in the schema's stage order, each with the overrides that win. */
export function previewRows(schema, resolved, shadows) {
  const extra = Object.keys(resolved.stages).filter((stage) => !schema.stages.includes(stage));
  return [...schema.stages, ...extra]
    .filter((stage) => resolved.stages[stage] !== undefined)
    .map((stage) => {
      const value = resolved.stages[stage];
      return {
        stage,
        runner: value.runner,
        model: value.model,
        ...(value.effort === undefined ? {} : { effort: value.effort }),
        ...(value.fallback === undefined ? {} : { fallback: value.fallback }),
        source: value.source,
        overrides: shadows.filter((shadow) => shadow.stage === stage),
      };
    });
}

export function shadowWarning(shadow) {
  return (
    `${shadow.variable} is set in the environment and overrides ${shadow.stage}'s ${shadow.field}, ` +
    `so a saved ${shadow.field} for ${shadow.stage} will not be what runs. Unset ${shadow.variable} ` +
    `and restart the loop for the file to take effect.`
  );
}

export class LineupHttpError extends Error {
  constructor(status, kind, message) {
    super(message);
    this.name = "LineupHttpError";
    this.status = status;
    this.kind = kind;
  }
}

const selectors = ({ root, loop } = {}) => ({
  ...(root === undefined ? {} : { root }),
  ...(loop === undefined ? {} : { loop }),
});

export function createLineupClient(fetchImpl, base = "") {
  async function request(path, init) {
    const response = await fetchImpl(base + path, init);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { response, body };
  }

  function failure(response, body) {
    const kind = isRecord(body) && typeof body.error === "string" ? body.error : "error";
    const message = isRecord(body) && typeof body.message === "string" ? body.message : `HTTP ${response.status}`;
    return new LineupHttpError(response.status, kind, message);
  }

  async function get(path) {
    const { response, body } = await request(path);
    if (!response.ok) throw failure(response, body);
    return body;
  }

  function post(path, payload) {
    return request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async function postView(path, payload) {
    const { response, body } = await post(path, payload);
    if (!response.ok) throw failure(response, body);
    return body;
  }

  return {
    async roots() {
      return (await get(ROOTS)).roots;
    },
    read(selector) {
      const query = new URLSearchParams(selectors(selector)).toString();
      return get(query === "" ? LINEUP : `${LINEUP}?${query}`);
    },
    preview(input) {
      return postView(PREVIEW, { ...selectors(input), config: input.config });
    },
    edit(input) {
      return postView(EDIT, { ...selectors(input), config: input.config, edit: input.edit });
    },
    async save(input) {
      const { response, body } = await post(SAVE, { ...selectors(input), config: input.config });
      // A refused candidate is the validator's verdict, not a failed request.
      if (response.ok || (response.status === 400 && isRecord(body) && typeof body.valid === "boolean")) return body;
      throw failure(response, body);
    },
  };
}
