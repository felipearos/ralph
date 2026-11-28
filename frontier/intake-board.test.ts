/**
 * Coder loops working from the clerk's Jira intake board (felipearos/ralph#443,
 * #450), with no frontier change.
 *
 * The backoffice project points its coder loops at the intake board with its
 * own `tracker` block — `kind: "jira"`, `project: "OAI"`, `scopeLabel:
 * "acme-backoffice"` — and lists `difficulty:easy|medium|hard` in Jav. The
 * clerk files every report into "Por confirmar" carrying `para-agente` or
 * `para-persona` and a `difficulty:*` label, and only the confirmation sweep
 * (`clerk/confirm.ts`) adds `ready-for-agent`, on a confirmed `para-agente`
 * ticket. The frontier already gates on `ready-for-agent` and Jav already
 * routes on the difficulty label, so this pins that the two together are the
 * whole of it: a confirmed hard ticket goes to the loop routed hard and to no
 * easy-only loop, and a ticket nobody has confirmed goes to nobody.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { javLabelsFor, type JavConfig } from "../jav";
import { createFakeTracker, type FakeIssue, type FakeTracker } from "../tracker/fake";
import {
  buildTickets,
  claimByNumber,
  classify,
  parseParent,
  readKeyedFrontierInputs,
  readLiveIssue,
  roleUnits,
  useFrontierTracker,
  useReferenceKey,
} from "./next-tasks";

// The claim labels come from the project's roster: loggd's ralph, rafa, remo, rulo, testo.
process.env.RALPH_PROJECT = join(__dirname, "..", "fixtures", "loggd");

afterEach(() => useFrontierTracker(null));

const SCOPE = "acme-backoffice";
const STATES = { claimed: "En curso", done: "Listo" };

/** The backoffice project's Jav block, as the README documents it: rafa takes the hard work, rulo the easy. */
const JAV: JavConfig = {
  enabled: true,
  labels: ["difficulty:easy", "difficulty:medium", "difficulty:hard"],
  routes: { rafa: ["difficulty:hard", "difficulty:medium"], rulo: ["difficulty:easy"] },
};

/** The intake board as the clerk and the sweep leave it. */
const BOARD: (Partial<FakeIssue> & { number: number })[] = [
  {
    number: 7,
    title: "No se puede exportar el reporte",
    status: "Confirmado",
    labels: ["slack-intake", SCOPE, "difficulty:hard", "para-agente", "ready-for-agent"],
  },
  {
    // Filed for an agent, still waiting for a person: no `ready-for-agent`.
    number: 8,
    title: "El filtro de fechas no guarda",
    status: "Por confirmar",
    labels: ["slack-intake", SCOPE, "difficulty:easy", "para-agente"],
  },
  {
    // Confirmed for a person: it moves to OA and never gets `ready-for-agent`.
    number: 9,
    title: "Cambiar el texto del correo",
    status: "Confirmado",
    labels: ["slack-intake", SCOPE, "difficulty:easy", "para-persona"],
  },
  {
    // Another app's ticket on the same board: outside the backoffice scope.
    number: 10,
    title: "La PWA no carga offline",
    status: "Confirmado",
    labels: ["slack-intake", "acme-pwa", "difficulty:easy", "para-agente", "ready-for-agent"],
  },
];

/**
 * The in-memory tracker as the Jira project OAI. Its listings are narrowed to
 * the scope label the way `tracker/jira.ts` narrows every JQL listing to it
 * (`labels = "<scopeLabel>"`, pinned in `tracker/jira.test.ts`); the board has
 * nothing closed, so only the open listing needs it.
 */
function intakeBoard(): FakeTracker {
  const tracker = createFakeTracker({ kind: "jira", key: "OAI", states: STATES, workflow: ["Por confirmar", "Confirmado", "En curso", "Listo"], issues: BOARD });
  const scoped = <T extends { labels: string[] }>(list: T[]): T[] => list.filter((issue) => issue.labels.includes(SCOPE));
  const openIssues = tracker.openIssues.bind(tracker);
  Object.assign(tracker, { openIssues: async (...args: Parameters<typeof openIssues>) => scoped(await openIssues(...args)) });
  return tracker;
}

async function offeredTo(tracker: FakeTracker, loop: string): Promise<number[]> {
  useFrontierTracker(tracker, "OAI", async () => [], SCOPE);
  useReferenceKey("OAI");
  const inputs = await readKeyedFrontierInputs(tracker, { gh: async () => "[]" });
  const tickets = buildTickets(inputs.raw, inputs.natives, new Set(inputs.closed.map((issue) => issue.number)), inputs.openPrs);
  const frontier = classify(tickets, inputs.closed.map((issue) => parseParent(issue.body)).filter((n): n is number => n !== null), {});
  const units = roleUnits("coder", tickets, frontier, { route: javLabelsFor(JAV, loop), javLabels: () => JAV.labels });
  return units.flatMap((unit) => unit.tickets.map((ticket) => ticket.number));
}

describe("coder loops on the intake board", () => {
  it("offers a confirmed hard ticket to the loop Jav routes hard to, and not to an easy-only loop", async () => {
    expect(await offeredTo(intakeBoard(), "rafa")).toEqual([7]);
    expect(await offeredTo(intakeBoard(), "rulo")).toEqual([]);
  });

  it("offers a ticket still in 'Por confirmar' to nobody, whatever its difficulty", async () => {
    for (const loop of ["rafa", "rulo", "ralph"]) expect(await offeredTo(intakeBoard(), loop)).not.toContain(8);
    // Not even with routing off: without `ready-for-agent` nothing is offered.
    const tracker = intakeBoard();
    useFrontierTracker(tracker, "OAI", async () => [], SCOPE);
    const inputs = await readKeyedFrontierInputs(tracker, { gh: async () => "[]" });
    const tickets = buildTickets(inputs.raw, inputs.natives, new Set(), inputs.openPrs);
    const units = roleUnits("coder", tickets, classify(tickets, [], {}), { route: null });
    expect(units.flatMap((unit) => unit.tickets.map((ticket) => ticket.number))).toEqual([7]);
  });

  it("is offered once the sweep confirms it, to the loop its difficulty routes to", async () => {
    const tracker = intakeBoard();
    tracker.put({ ...tracker.issues.get(8)!, status: "Confirmado", labels: [...tracker.issues.get(8)!.labels, "ready-for-agent"] });
    expect(await offeredTo(tracker, "rulo")).toEqual([8]);
    expect(await offeredTo(tracker, "rafa")).toEqual([7]);
  });

  it("claims through the same fence as any keyed tracker, moving the ticket to the claimed state", async () => {
    const tracker = intakeBoard();
    useFrontierTracker(tracker, "OAI", async () => [], SCOPE);
    const io = { readLive: readLiveIssue, claim: async (n: number, label: string) => void (await tracker.claim(n, label)), isOpenPr: async () => true };
    expect((await claimByNumber(7, "rafa-wip", io)).claimed).toBe(true);
    expect(tracker.issues.get(7)!.status).toBe("En curso");
    expect(await claimByNumber(7, "rulo-wip", io)).toMatchObject({ claimed: false, refusal: "labeled rafa-wip" });

    // And the next pick for rafa names nothing: the only ticket routed to it is held.
    expect(await offeredTo(tracker, "rafa")).toEqual([]);
  });
});
