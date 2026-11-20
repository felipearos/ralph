/**
 * The plugin doctor over HTTP: `POST /api/doctor`.
 *
 * One route, three actions, all answered with the same `DoctorView`:
 *
 *   diagnose   every enabled plugin's checks. With none enabled the answer
 *              has no plugins, and the page shows no panel.
 *   repair     one repair on one check of one plugin: `plugin`, `check` and
 *              `repair` are required. Turning a plugin off for the project
 *              changes its committed config, so it must carry
 *              `"confirm": true`; the server enforces it.
 *   fix-all    one plugin's checks in order, repaired until one cannot be.
 *
 * A POST, not a GET, even to diagnose: a diagnosis is recorded in the loop's
 * repair history and asks the plugin's backend questions, so it is not an
 * observation. Which repairs exist and whether one applies is the doctor's
 * answer, never judged here — this route validates shape, resolves the loop
 * to its checkout, runs the doctor and serializes.
 */
import { DOCTOR_ACTIONS, type Dashboard, type DoctorAction, type DoctorView } from "./contracts";
import { ControlRouteError, invalid, json, optionalText, readBody } from "./command-requests";
import { targetFor, type ControlTarget } from "./control-routes";
import { DOCTOR_SURFACE, type DoctorAdapter, type DoctorRequest } from "./doctor-adapter";

export const DOCTOR_PATH = "/api/doctor";

export type DoctorFactory = (target: ControlTarget) => DoctorAdapter;

export interface DoctorRouteOptions {
  doctor: DoctorFactory;
  dashboard: () => Promise<Dashboard>;
}

export function parseDoctorRequest(body: unknown): DoctorRequest & { loop: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("the request body must be a JSON object");
  const fields = body as Record<string, unknown>;
  const loop = optionalText(fields, "loop");
  if (loop === null) throw invalid("'loop' is required: name the loop whose plugins to diagnose");
  const action = optionalText(fields, "action") ?? "diagnose";
  if (!(DOCTOR_ACTIONS as readonly string[]).includes(action)) {
    throw invalid(`unknown doctor action '${action}'; expected one of ${DOCTOR_ACTIONS.join(", ")}`);
  }
  const plugin = optionalText(fields, "plugin");
  const check = optionalText(fields, "check");
  const repair = optionalText(fields, "repair");
  if (action !== "diagnose" && plugin === null) throw invalid(`'plugin' is required for ${action}`);
  if (action === "repair" && (check === null || repair === null)) {
    throw invalid("'check' and 'repair' are required for repair: name the failed check and the repair it offered");
  }
  if (action !== "repair" && (check !== null || repair !== null)) throw invalid("'check' and 'repair' apply only to repair");
  if (repair === DOCTOR_SURFACE.disableRepair && fields.confirm !== true) {
    throw new ControlRouteError(
      400,
      "ConfirmationRequired",
      `turning the plugin off changes the project's .ralph/config.json: send it with "confirm": true`,
    );
  }
  return { loop, action: action as DoctorAction, plugin, check, repair };
}

export async function handleDoctorRoute(
  request: Request,
  pathname: string,
  options: DoctorRouteOptions,
): Promise<Response | null> {
  if (pathname !== DOCTOR_PATH) return null;
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  try {
    const { loop, ...doctorRequest } = parseDoctorRequest(await readBody(request));
    const target = await targetFor(options.dashboard, loop);
    return json((await options.doctor(target).run(target.loop, doctorRequest)) satisfies DoctorView);
  } catch (error) {
    if (error instanceof ControlRouteError) {
      return json({ error: error.name, message: error.message }, error.status);
    }
    throw error;
  }
}
