/**
 * The Evals tab over HTTP (#801):
 *
 *   GET  /api/evals              the project's runs, a summary snapshot (relayed)
 *   POST /api/evals/start        {"plan": {...}}  start a run (relayed)
 *   POST /api/evals/stop         {"run": "<id>"}  stop one, resumable (relayed)
 *   GET  /api/evals/patch?run=&case=&arm=        a trial's patch (this host only)
 *   GET  /api/evals/patches      every patch the project lets the bridge relay; empty unless opted in
 *   GET  /api/evals/set          the test set, a summary snapshot (relayed; #856)
 *   GET  /api/evals/set/case?id= one case's tags, reason and notes for the edit form (this host only)
 *   GET  /api/evals/suggestions  merged PRs worth adding as cases, ranked (relayed; #858)
 *   POST /api/evals/set/add      {"repo", "prs", "reason", "tags"?, "notes"?}  add a case (relayed)
 *   POST /api/evals/set/edit     {"case", "tags"?, "notes"?}  edit a case's curation (relayed)
 *   POST /api/evals/set/retire   {"case"}  retire a case (relayed)
 *   POST /api/evals/set/keep     {"case"}  keep a saturated case, restarting its saturation window (relayed; #860)
 *   POST /api/evals/set/check    {"case", "test" | "command"}  attach a check, verified on base and reference (relayed; #857)
 *   POST /api/evals/set/calibrate {"case", "arms", "axis", "preferred", "reason"}  record which of two arms was better on an axis (relayed; #876)
 *   GET  /api/evals/inbox        the recommended runs, counts and reasons, never a plan (relayed; #872)
 *   POST /api/evals/inbox/add    {"plan", "reason"?}  recommend a plan into the inbox (relayed)
 *   POST /api/evals/inbox/start  {"entry"}  start an entry's plan, removing it once started (relayed)
 *   POST /api/evals/inbox/dismiss {"entry"}  drop an entry unrun (relayed)
 *   GET  /api/evals/proposals    the improver's proposals: goal, kind, status, verdict; never content or a diff (relayed; #874)
 *   POST /api/evals/improve/propose {"run", "goal"}  start the improver on a finished run, detached; its proposal lands in the inbox (relayed; #873)
 *   POST /api/evals/proposals/open-pr {"proposal"}  open the PR a passed proposal stands for, or answer the one open (relayed; #875)
 *
 * A thin route over the adapter: it judges the body's shape and nothing else.
 * Whether a plan would run, or a PR makes a case, is the harness's answer,
 * returned as a refusal.
 */
import type { EvalImproveResult, EvalInboxView, EvalOpenPrResult, EvalInboxWriteResult, EvalPatchesView, EvalProposalsView, EvalSetView, EvalSetWriteResult, EvalsView, EvalStartResult, EvalStopResult, EvalSuggestionsView } from "./contracts";
import {
  ControlRouteError, EVAL_CASE_ID_SHAPE, invalid, json, parseEvalImprovePropose, parseEvalInboxAdd, parseEvalInboxEntry, parseEvalProposalOpenPr, parseEvalSetAdd, parseEvalSetCalibrate, parseEvalSetCheck, parseEvalSetEdit, parseEvalSetKeep, parseEvalSetRetire, parseEvalStart, parseEvalStop, readBody,
} from "./command-requests";
import type { EvalsAdapter } from "./evals-adapter";

export const EVALS_PATH = "/api/evals";
export const EVALS_START_PATH = "/api/evals/start";
export const EVALS_STOP_PATH = "/api/evals/stop";
export const EVALS_PATCH_PATH = "/api/evals/patch";
export const EVALS_PATCHES_PATH = "/api/evals/patches";
export const EVALS_SET_PATH = "/api/evals/set";
export const EVALS_SET_CASE_PATH = "/api/evals/set/case";
export const EVALS_SET_ADD_PATH = "/api/evals/set/add";
export const EVALS_SET_EDIT_PATH = "/api/evals/set/edit";
export const EVALS_SET_RETIRE_PATH = "/api/evals/set/retire";
export const EVALS_SET_KEEP_PATH = "/api/evals/set/keep";
export const EVALS_SET_CHECK_PATH = "/api/evals/set/check";
export const EVALS_SET_CALIBRATE_PATH = "/api/evals/set/calibrate";
export const EVALS_SUGGESTIONS_PATH = "/api/evals/suggestions";
export const EVALS_INBOX_PATH = "/api/evals/inbox";
export const EVALS_INBOX_ADD_PATH = "/api/evals/inbox/add";
export const EVALS_INBOX_START_PATH = "/api/evals/inbox/start";
export const EVALS_INBOX_DISMISS_PATH = "/api/evals/inbox/dismiss";
export const EVALS_PROPOSALS_PATH = "/api/evals/proposals";
export const EVALS_IMPROVE_PROPOSE_PATH = "/api/evals/improve/propose";
export const EVALS_PROPOSAL_OPEN_PR_PATH = "/api/evals/proposals/open-pr";

const SEGMENT = /^[\w.-]+$/;

/** The response for an evals path, or null when the path is not one. */
export async function handleEvalsRoute(request: Request, pathname: string, evals: EvalsAdapter): Promise<Response | null> {
  const paths: Record<string, string> = {
    [EVALS_PATH]: "GET", [EVALS_PATCH_PATH]: "GET", [EVALS_PATCHES_PATH]: "GET", [EVALS_START_PATH]: "POST", [EVALS_STOP_PATH]: "POST",
    [EVALS_SET_PATH]: "GET", [EVALS_SET_CASE_PATH]: "GET", [EVALS_SET_ADD_PATH]: "POST", [EVALS_SET_EDIT_PATH]: "POST", [EVALS_SET_RETIRE_PATH]: "POST",
    [EVALS_SET_CHECK_PATH]: "POST", [EVALS_SET_KEEP_PATH]: "POST", [EVALS_SET_CALIBRATE_PATH]: "POST",
    [EVALS_SUGGESTIONS_PATH]: "GET",
    [EVALS_INBOX_PATH]: "GET", [EVALS_INBOX_ADD_PATH]: "POST", [EVALS_INBOX_START_PATH]: "POST", [EVALS_INBOX_DISMISS_PATH]: "POST",
    [EVALS_PROPOSALS_PATH]: "GET", [EVALS_PROPOSAL_OPEN_PR_PATH]: "POST",
    [EVALS_IMPROVE_PROPOSE_PATH]: "POST",
  };
  const method = paths[pathname];
  if (method === undefined) return null;
  if (request.method !== method) return new Response("method not allowed", { status: 405, headers: { allow: method } });
  try {
    if (pathname === EVALS_PATH) return json((await evals.runs()) satisfies EvalsView);
    if (pathname === EVALS_PATCHES_PATH) return json((await evals.patches()) satisfies EvalPatchesView);
    if (pathname === EVALS_PATCH_PATH) {
      const search = new URL(request.url).searchParams;
      const [run, ticket, arm] = ["run", "case", "arm"].map((name) => search.get(name) ?? "");
      for (const [name, value] of [["run", run], ["case", ticket], ["arm", arm]] as const) {
        if (!SEGMENT.test(value!) || value!.startsWith(".")) throw invalid(`'${name}' is required: one path segment`);
      }
      const patch = await evals.patch(run!, ticket!, arm!);
      if (!patch.ok) return json({ error: "NoPatch", message: patch.why }, 404);
      return new Response(patch.text, { headers: { "content-type": "text/x-diff; charset=utf-8", "cache-control": "no-store" } });
    }
    if (pathname === EVALS_SET_PATH) return json((await evals.set()) satisfies EvalSetView);
    if (pathname === EVALS_SUGGESTIONS_PATH) return json((await evals.suggestions()) satisfies EvalSuggestionsView);
    if (pathname === EVALS_INBOX_PATH) return json((await evals.inbox()) satisfies EvalInboxView);
    if (pathname === EVALS_PROPOSALS_PATH) return json((await evals.proposals()) satisfies EvalProposalsView);
    if (pathname === EVALS_SET_CASE_PATH) {
      const id = new URL(request.url).searchParams.get("id") ?? "";
      if (!EVAL_CASE_ID_SHAPE.test(id)) throw invalid("'id' is required: a case id in lowercase kebab-case");
      const found = await evals.setCase(id);
      if (!found.ok) return json({ error: "NoCase", message: found.why }, 404);
      return json(found.case);
    }
    const body = await readBody(request);
    if (pathname === EVALS_SET_ADD_PATH) return json((await evals.setAdd(parseEvalSetAdd(body))) satisfies EvalSetWriteResult);
    if (pathname === EVALS_SET_EDIT_PATH) return json((await evals.setEdit(parseEvalSetEdit(body))) satisfies EvalSetWriteResult);
    if (pathname === EVALS_SET_RETIRE_PATH) return json((await evals.setRetire(parseEvalSetRetire(body).case)) satisfies EvalSetWriteResult);
    if (pathname === EVALS_SET_KEEP_PATH) return json((await evals.setKeep(parseEvalSetKeep(body).case)) satisfies EvalSetWriteResult);
    if (pathname === EVALS_SET_CHECK_PATH) return json((await evals.setCheck(parseEvalSetCheck(body))) satisfies EvalSetWriteResult);
    if (pathname === EVALS_SET_CALIBRATE_PATH) return json((await evals.setCalibrate(parseEvalSetCalibrate(body))) satisfies EvalSetWriteResult);
    if (pathname === EVALS_INBOX_ADD_PATH) return json((await evals.inboxAdd(parseEvalInboxAdd(body))) satisfies EvalInboxWriteResult);
    if (pathname === EVALS_INBOX_START_PATH) return json((await evals.inboxStart(parseEvalInboxEntry(body).entry)) satisfies EvalInboxWriteResult);
    if (pathname === EVALS_INBOX_DISMISS_PATH) return json((await evals.inboxDismiss(parseEvalInboxEntry(body).entry)) satisfies EvalInboxWriteResult);
    if (pathname === EVALS_IMPROVE_PROPOSE_PATH) return json((await evals.improvePropose(parseEvalImprovePropose(body))) satisfies EvalImproveResult);
    if (pathname === EVALS_PROPOSAL_OPEN_PR_PATH) return json((await evals.openProposalPr(parseEvalProposalOpenPr(body))) satisfies EvalOpenPrResult);
    if (pathname === EVALS_START_PATH) return json((await evals.start(parseEvalStart(body).plan)) satisfies EvalStartResult);
    return json((await evals.stop(parseEvalStop(body).run)) satisfies EvalStopResult);
  } catch (error) {
    if (error instanceof ControlRouteError) return json({ error: error.name, message: error.message }, error.status);
    throw error;
  }
}
