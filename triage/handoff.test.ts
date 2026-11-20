import { describe, expect, it } from "vitest";
import { APP_LABELS } from "../clerk/fakes";

import { SITE, fakeJira, type FakeJira } from "../clerk/fakes";
import { jiraClient } from "../clerk/jira";
import { filedMarker } from "../clerk/live";
import type { TriageJira } from "../project-config";
import { FakeThrottle, createFakeTracker, type FakeIssue, type FakeTracker } from "../tracker/fake";
import { formatTriageMarker, triageBodyHash } from "../triage-marker";
import { opMarker } from "./body";
import { handoffPass } from "./gate";
import { applyKeyedPlan } from "./keyed";
import {
  MOVED_OP,
  SHADOW_OP,
  handOff,
  handoffFields,
  jiraDescription,
  intakeMarker,
  linearMarker,
  moveToJira,
  movedKey,
  pendingHandoffs,
  strippedDescription,
  type HandoffDeps,
  type HandoffFields,
} from "./handoff";

const UNIT = 42;
const SCOPE = "acme-backoffice";
const PERMALINK = "https://example.slack.com/archives/C1/p1700000000000100";
const REASON = "Prioridad Highest: la revisa una persona.";

const DESCRIPTION = [
  "El botón de exportar no hace nada.",
  `Reportado por Ana en Slack: ${PERMALINK}`,
  "Mensaje original:\n> no exporta",
].join("\n\n");

const BODY = [DESCRIPTION, "Tipo: Error\nPrioridad: Highest\nApp: Backoffice", filedMarker(PERMALINK)].join("\n\n");

const marker = (outcome: "to-person" | "propose", op = "release-1"): string =>
  formatTriageMarker({ attempt: 1, outcome, body: triageBodyHash(BODY) }, { loop: "tria", unit: UNIT, op, labels: [] });

const toPersonComment = { body: `Triage: requiere una persona. ${REASON}\n\n${marker("to-person")}\n${opMarker("release-1")}` };

function trackerWith(issue: Partial<FakeIssue> = {}, more: (Partial<FakeIssue> & { number: number })[] = []): FakeTracker {
  return createFakeTracker({
    kind: "linear",
    key: "AND",
    issues: [
      {
        number: UNIT,
        title: "Exportar no funciona",
        body: BODY,
        labels: ["slack-intake", SCOPE],
        comments: [toPersonComment],
        ...issue,
      },
      ...more,
    ],
  });
}

const RULES = (mode: TriageJira["mode"]): TriageJira => ({ mode, site: SITE, project: "OA", issueTypes: { Error: "Bug", Tarea: "Task" } });

function depsFor(tracker: FakeTracker, mode: TriageJira["mode"], jira: FakeJira | null = fakeJira()): HandoffDeps {
  return {
    tracker,
    jira: jira === null ? null : jiraClient(SITE, { email: "bot@example.com", token: "t" }, jira.fetch),
    rules: RULES(mode),
    sleep: async () => {},
    spacingMs: 0,
  };
}

const commentsWith = (tracker: FakeTracker, op: string): number =>
  tracker.issues.get(UNIT)!.comments.filter((comment) => comment.body.includes(opMarker(op))).length;

const creates = (jira: FakeJira) => jira.writes().filter((call) => call.path === "/rest/api/3/issue");

describe("handoff fields", () => {
  it("reads type, priority, reason and links, and strips the clerk's field block and marker", async () => {
    const tracker = trackerWith();
    const fields = handoffFields(await tracker.issue(UNIT), "AND-42");
    expect(fields).toMatchObject({ type: "Error", priority: "Highest", summary: "Exportar no funciona", reason: REASON, permalink: PERMALINK });
    expect(strippedDescription(BODY)).toBe(DESCRIPTION);
    const text = jiraDescription(fields as Exclude<typeof fields, { problem: string }>);
    expect(text).toContain(`Por qué requiere una persona: ${REASON}`);
    expect(text).toContain(`Hilo de Slack: ${PERMALINK}`);
    expect(text).toContain(`Issue en Linear: ${tracker.url(UNIT)}`);
    expect(text.endsWith("\n\nlinearissueand42fin")).toBe(true);
    expect(text).not.toContain("Tipo:");
  });

  it("strips the difficulty, points and assignee lines the clerk writes in its field block (felipearos/ralph#444)", () => {
    const fields = "Tipo: Error\nPrioridad: Highest\nApp: Backoffice\nDificultad: hard\nPuntos de historia sugeridos: 5\nAsignado a: persona";
    expect(strippedDescription([DESCRIPTION, fields, filedMarker(PERMALINK)].join("\n\n"))).toBe(DESCRIPTION);
  });

  it("omits the Slack line when the description names no thread", async () => {
    const body = BODY.replace(`Reportado por Ana en Slack: ${PERMALINK}\n\n`, "");
    const fields = handoffFields({ ...(await trackerWith().issue(UNIT)), body }, "AND-42");
    expect("problem" in fields).toBe(false);
    expect(jiraDescription(fields as never)).not.toContain("Hilo de Slack");
  });

  it("refuses a report with no type line rather than guess one", async () => {
    const body = BODY.replace("Tipo: Error\n", "");
    const fields = handoffFields({ ...(await trackerWith().issue(UNIT)), body }, "AND-42");
    expect(fields).toMatchObject({ problem: expect.stringContaining("no report type") });
  });

  it("makes the marker one lowercase word", () => {
    expect(linearMarker("AND-184")).toBe("linearissueand184fin");
  });
});

describe("pendingHandoffs", () => {
  it("offers a to-person report and skips propose-marked, untriaged, out-of-scope and outcome-labelled ones", async () => {
    const tracker = trackerWith({}, [
      { number: 43, labels: ["slack-intake", SCOPE], comments: [{ body: `brief\n\n${marker("propose")}` }] },
      { number: 44, labels: ["slack-intake", SCOPE], comments: [] },
      { number: 45, body: BODY, labels: ["slack-intake"], comments: [toPersonComment] },
      { number: 46, labels: ["slack-intake", SCOPE, "agent-proposed"], comments: [toPersonComment] },
      { number: 47, labels: ["slack-intake", SCOPE], comments: [toPersonComment], state: "closed" },
    ]);
    expect(await pendingHandoffs(tracker, { scopeLabel: SCOPE, mode: "live" })).toEqual([UNIT]);
    expect(await pendingHandoffs(tracker, { scopeLabel: null, mode: "shadow" })).toEqual([UNIT, 45]);
  });

  it("in shadow, a moved-to-jira report is done", async () => {
    const tracker = trackerWith({ labels: ["slack-intake", SCOPE, "moved-to-jira"] });
    expect(await pendingHandoffs(tracker, { scopeLabel: SCOPE, mode: "shadow" })).toEqual([]);
  });

  it("in live, a report shadow already labelled is not re-sent", async () => {
    const tracker = trackerWith({
      labels: ["slack-intake", SCOPE, "moved-to-jira"],
      comments: [toPersonComment, { body: `Se crearía OA-? con:\n\n${opMarker(SHADOW_OP)}` }],
    });
    expect(await pendingHandoffs(tracker, { scopeLabel: SCOPE, mode: "live" })).toEqual([]);
  });

  it("does not offer a to-person report whose body was edited after the decision", async () => {
    const tracker = trackerWith({ body: `${BODY}\n\nEditado: ahora sí exporta.` });
    expect(await pendingHandoffs(tracker, { scopeLabel: SCOPE, mode: "live" })).toEqual([]);
  });

  it("does not offer one a person commented on after the decision; the gate's own comments do not count", async () => {
    const person = trackerWith({ comments: [toPersonComment, { body: "Lo veo yo." }] });
    expect(await pendingHandoffs(person, { scopeLabel: SCOPE, mode: "live" })).toEqual([]);
    const shadowed = trackerWith({ comments: [toPersonComment, { body: `Se crearía OA-? con:\n\n${opMarker(SHADOW_OP)}` }] });
    expect(await pendingHandoffs(shadowed, { scopeLabel: SCOPE, mode: "shadow" })).toEqual([UNIT]);
  });

  it("in live, a labelled report with the move's comment is still pending (crash before the cancel)", async () => {
    const tracker = trackerWith({
      labels: ["slack-intake", SCOPE, "moved-to-jira"],
      comments: [toPersonComment, { body: `Pasa al equipo: OA-7\n\n${opMarker(MOVED_OP)}` }],
    });
    expect(await pendingHandoffs(tracker, { scopeLabel: SCOPE, mode: "live" })).toEqual([UNIT]);
  });
});

describe("handOff: live", () => {
  it("creates, comments, labels and cancels, in that order, with the mapped fields", async () => {
    const tracker = trackerWith();
    const jira = fakeJira();
    const log: string[] = [];
    const fetcher = jira.fetch;
    jira.fetch = async (url, init) => {
      if ((init.method ?? "GET") === "POST" && new URL(url).pathname === "/rest/api/3/issue") log.push("create");
      return fetcher(url, init);
    };
    for (const op of ["comment", "addLabels", "cancel"] as const) {
      const original = tracker[op] as (...args: unknown[]) => Promise<unknown>;
      (tracker as unknown as Record<string, unknown>)[op] = (...args: unknown[]) => {
        log.push(op);
        return original(...args);
      };
    }

    const result = await handOff(UNIT, depsFor(tracker, "live", jira));

    expect(result).toMatchObject({ outcome: "moved", key: "OA-100", writes: 4, problem: null });
    expect(log).toEqual(["create", "comment", "addLabels", "cancel"]);
    const fields = (creates(jira)[0]!.body as { fields: Record<string, unknown> }).fields;
    expect(fields).toMatchObject({
      project: { key: "OA" },
      issuetype: { name: "Bug" },
      summary: "Exportar no funciona",
      labels: ["slack-intake"],
      priority: { name: "Highest" },
    });
    // Nobody: the team assigns, and OA would otherwise give it to its lead.
    expect(fields.assignee).toBeNull();
    const adf = JSON.stringify(fields.description);
    expect(adf).toContain(REASON);
    expect(adf).toContain(`"href":"${PERMALINK}"`);
    expect(adf).toContain(`"href":"${tracker.url(UNIT)}"`);
    const issue = tracker.issues.get(UNIT)!;
    expect(issue.comments.at(-1)!.body).toContain("Pasa al equipo: OA-100");
    expect(issue.labels).toContain("moved-to-jira");
    expect(issue.state).toBe("closed");
  });

  it("reuses a ticket a search finds by the marker", async () => {
    const tracker = trackerWith();
    const jira = fakeJira();
    jira.add({ key: "OA-9", summary: "Exportar", labels: ["slack-intake"], description: `x\n${linearMarker("AND-42")}` });
    const result = await handOff(UNIT, depsFor(tracker, "live", jira));
    expect(result).toMatchObject({ outcome: "moved", key: "OA-9", writes: 3 });
    expect(creates(jira)).toHaveLength(0);
  });

  it("finishes after a 5xx on the create, with one ticket", async () => {
    const tracker = trackerWith();
    const jira = fakeJira();
    jira.fail("/rest/api/3/issue", { status: 502 }, { method: "POST" });
    expect(await handOff(UNIT, depsFor(tracker, "live", jira))).toMatchObject({ outcome: "waiting", writes: 0 });
    expect(tracker.writes).toEqual([]);
    expect(await handOff(UNIT, depsFor(tracker, "live", jira))).toMatchObject({ outcome: "moved", key: "OA-100" });
    expect(jira.issues).toHaveLength(1);
  });

  for (const step of ["comment", "addLabels", "cancel"] as const) {
    it(`a re-run after a crash at ${step} completes without a second ticket, comment or label`, async () => {
      const tracker = trackerWith();
      const jira = fakeJira();
      tracker.failNext(step, new Error(`${step} crashed`));
      expect(await handOff(UNIT, depsFor(tracker, "live", jira))).toMatchObject({ outcome: "failed", problem: `${step} crashed` });
      expect(await pendingHandoffs(tracker, { scopeLabel: SCOPE, mode: "live" })).toEqual([UNIT]);
      expect(await handOff(UNIT, depsFor(tracker, "live", jira))).toMatchObject({ outcome: "moved", key: "OA-100" });
      expect(jira.issues).toHaveLength(1);
      expect(creates(jira)).toHaveLength(1);
      expect(commentsWith(tracker, MOVED_OP)).toBe(1);
      expect(tracker.writes.filter((write) => write.startsWith("label+"))).toHaveLength(1);
      expect(tracker.issues.get(UNIT)!.state).toBe("closed");
      expect(await pendingHandoffs(tracker, { scopeLabel: SCOPE, mode: "live" })).toEqual([]);
    });
  }

  it("trusts only the gate's own move comment for the key", async () => {
    // A person's hand-written line, without the op marker, is not a ticket.
    const forged = [toPersonComment, { body: "Pasa al equipo: OA-9" }];
    expect(movedKey(forged)).toBeNull();
    expect(movedKey([...forged, { body: `Pasa al equipo: OA-7\n\n${opMarker(MOVED_OP)}` }])).toBe("OA-7");
    const tracker = trackerWith({ comments: forged });
    const jira = fakeJira();
    expect(await handOff(UNIT, depsFor(tracker, "live", jira))).toMatchObject({ outcome: "moved", key: "OA-100" });
    expect(creates(jira)).toHaveLength(1);
  });

  it("clips a hand-edited title to the summary Jira takes", async () => {
    const tracker = trackerWith({ title: "x".repeat(300) });
    const jira = fakeJira();
    await handOff(UNIT, depsFor(tracker, "live", jira));
    const summary = (creates(jira)[0]!.body as { fields: { summary: string } }).fields.summary;
    expect(summary).toHaveLength(255);
    expect(summary.endsWith("...")).toBe(true);
  });

  it("fails the one report on a 400, without a denial", async () => {
    const jira = fakeJira();
    jira.fail("/rest/api/3/issue", { status: 400 }, { method: "POST" });
    const result = await handOff(UNIT, depsFor(trackerWith(), "live", jira));
    expect(result).toMatchObject({ outcome: "failed", problem: expect.stringContaining("HTTP 400") });
    expect(result.denial).toBeUndefined();
  });

  it("is denied on a 404, naming the triager's config block", async () => {
    const jira = fakeJira();
    jira.fail("/rest/api/3/issue", { status: 404 }, { method: "POST" });
    const result = await handOff(UNIT, depsFor(trackerWith(), "live", jira));
    expect(result.outcome).toBe("denied");
    expect(result.denial).toMatchObject({ code: "jira_not_found", remedy: expect.stringContaining("'triage.jira'") });
    expect(result.denial!.remedy).not.toContain("'clerk.jira'");
  });

  it("waits on a 429 for what Jira said", async () => {
    const jira = fakeJira();
    jira.fail("/rest/api/3/search/jql", { status: 429, retryAfter: "30" });
    const result = await handOff(UNIT, depsFor(trackerWith(), "live", jira));
    expect(result).toMatchObject({ outcome: "waiting", retryAfterSeconds: 30, writes: 0 });
  });

  it("is denied on a 403, with the remedy", async () => {
    const jira = fakeJira();
    jira.fail("/rest/api/3/issue", { status: 403 }, { method: "POST" });
    const result = await handOff(UNIT, depsFor(trackerWith(), "live", jira));
    expect(result.outcome).toBe("denied");
    expect(result.denial).toMatchObject({ code: "jira_forbidden", remedy: expect.stringContaining("RALPH_CLERK_JIRA_TOKEN") });
  });

  it("waits on a tracker throttle", async () => {
    const tracker = trackerWith();
    tracker.failNext("issue", new FakeThrottle({ kind: "secondary", retryAfterSeconds: 60 } as never));
    expect(await handOff(UNIT, depsFor(tracker, "live"))).toMatchObject({ outcome: "waiting", retryAfterSeconds: 60 });
  });

  it("is denied with no Jira credential, and writes nothing", async () => {
    const tracker = trackerWith();
    const result = await handOff(UNIT, depsFor(tracker, "live", null));
    expect(result).toMatchObject({ outcome: "denied", writes: 0, denial: { code: "no_jira_credential" } });
    expect(result.denial!.remedy).toContain("RALPH_CLERK_JIRA_TOKEN");
    expect(tracker.writes).toEqual([]);
  });
});

describe("handOff: shadow", () => {
  it("posts one comment with the would-be fields and labels, with no Jira call; a re-run writes nothing", async () => {
    const tracker = trackerWith();
    const jira = fakeJira();
    expect(await handOff(UNIT, depsFor(tracker, "shadow", jira))).toMatchObject({ outcome: "shadowed", key: null, writes: 2 });
    expect(jira.calls).toEqual([]);
    const issue = tracker.issues.get(UNIT)!;
    const comment = issue.comments.at(-1)!.body;
    expect(comment.startsWith("Se crearía OA-? con:")).toBe(true);
    for (const line of ["Tipo: Bug", "Prioridad: Highest", "Resumen: Exportar no funciona", "Etiquetas: slack-intake", "Descripción:", REASON]) {
      expect(comment).toContain(line);
    }
    expect(issue.labels).toContain("moved-to-jira");
    expect(issue.state).toBe("open");

    expect(await handOff(UNIT, depsFor(tracker, "shadow", jira))).toMatchObject({ outcome: "shadowed", writes: 0 });
    expect(commentsWith(tracker, SHADOW_OP)).toBe(1);
    expect(jira.calls).toEqual([]);
  });
});

describe("a to-person decision, applied and then moved (#397)", () => {
  it("moves the report the triager's apply marked, end to end", async () => {
    // The issue as the clerk files it, claimed by the triager.
    const tracker = trackerWith({ comments: [], labels: ["slack-intake", SCOPE, "tria-wip"] });
    const applied = await applyKeyedPlan(
      {
        unit: UNIT,
        loop: "tria",
        attempt: 1,
        outcome: "to-person",
        ops: [{ op: "to-person", opId: "person", issue: UNIT, reason: REASON }],
      },
      {
        tracker,
        rules: { scopeLabel: SCOPE, apps: APP_LABELS, loop: "tria", autoReady: false },
        dryRun: false,
        releaseLease: () => {},
        sleep: async () => {},
        spacingMs: 0,
      },
    );
    expect(applied).toMatchObject({ outcome: "applied", problem: null });

    const jira = fakeJira();
    const lines: string[] = [];
    await handoffPass({
      tracker,
      jira: jiraClient(SITE, { email: "bot@example.com", token: "t" }, jira.fetch),
      rules: RULES("live"),
      scopeLabel: SCOPE,
      log: (line) => lines.push(line),
      notify: () => {},
      stop: () => {},
      alert: () => {},
      lock: () => () => {},
      sleep: async () => {},
      spacingMs: 0,
    });

    expect(lines).toEqual(["triage-gate: AND-42 moved to OA-100"]);
    expect(creates(jira)).toHaveLength(1);
    expect(JSON.stringify(creates(jira)[0]!.body)).toContain(REASON);
    const issue = tracker.issues.get(UNIT)!;
    expect(issue.comments.at(-1)!.body).toContain("Pasa al equipo: OA-100");
    expect(issue.labels).toContain("moved-to-jira");
    expect(issue.state).toBe("closed");
  });
});

describe("moveToJira from the intake board (felipearos/ralph#449)", () => {
  const FIELDS: HandoffFields = {
    type: "Tarea",
    priority: "High",
    summary: "Exportar no funciona",
    description: "El botón de exportar no hace nada.",
    reason: "Confirmado para una persona por Ana Pérez.",
    permalink: PERMALINK,
    url: `https://${SITE}/browse/OAI-7`,
    ref: "OAI-7",
    origin: "intake",
  };
  const rules: TriageJira = { ...RULES("live"), issueTypes: { Error: "Error", Tarea: "Tarea" } };

  it("gives the intake marker its own word, never a Linear ref's", () => {
    expect(intakeMarker("OAI-7")).toBe("intaketicketoai7fin");
    expect(intakeMarker("AND-42")).not.toBe(linearMarker("AND-42"));
    const description = jiraDescription(FIELDS);
    expect(description).toContain(`Ticket en el tablero de ingreso: https://${SITE}/browse/OAI-7`);
    expect(description).not.toContain("Linear");
    expect(description.endsWith(intakeMarker("OAI-7"))).toBe(true);
  });

  it("files once, comments, labels and closes, and a rerun after a kill finds the ticket by its marker", async () => {
    const jira = fakeJira();
    const client = jiraClient(SITE, { email: "bot@example.com", token: "t" }, jira.fetch);
    const source = {
      comments: [
        { body: "Respuesta de Marta en Slack: la sucursal sale en México" },
        { body: "Contexto de código: src/features/sucursales" },
        { body: `Algo que el harness escribió\n\n${opMarker("triage-intake")}` },
      ] as { body: string }[],
      labels: [] as string[],
      closed: false,
    };
    const deps = (crashAt: "comment" | null = null) => ({
      jira: client,
      rules,
      write: <T>(call: () => Promise<T>) => call(),
      comment: async (body: string) => {
        if (crashAt === "comment") throw new Error("killed");
        source.comments.push({ body });
      },
      addLabel: async (label: string) => {
        source.labels.push(label);
      },
      close: async () => {
        source.closed = true;
        return { movedTo: "Movido", warning: null };
      },
    });
    const read = () => ({ ref: "OAI-7", comments: [...source.comments], labels: [...source.labels], open: !source.closed });

    await expect(moveToJira(read(), FIELDS, deps("comment"))).rejects.toThrow("killed");
    expect(creates(jira)).toHaveLength(1);
    const moved = await moveToJira(read(), FIELDS, deps());
    expect(moved).toEqual({ key: "OA-100", closeWarning: null, linkWarning: null, parentWarning: null });
    expect(creates(jira)).toHaveLength(1);
    // Explicitly unassigned: OA's default assignee is its lead.
    expect((creates(jira)[0]!.body as { fields: Record<string, unknown> }).fields).toMatchObject({ issuetype: { name: "Tarea" }, priority: { name: "High" }, assignee: null });
    // The intake ticket's comments, copied once each across the killed run and
    // its rerun; the harness's own op comments stay behind.
    const copied = jira.issues.find((issue) => issue.key === "OA-100")!.comments!;
    expect(copied).toHaveLength(2);
    expect(copied[0]).toContain("Copiado de OAI-7:");
    expect(copied[0]).toContain("Respuesta de Marta en Slack: la sucursal sale en México");
    expect(copied[1]).toContain("Contexto de código: src/features/sucursales");
    expect(source.comments.slice(3).map((comment) => comment.body)).toEqual([`Pasa al equipo: OA-100\n\nhttps://${SITE}/browse/OA-100\n\n${opMarker(MOVED_OP)}`]);
    expect(source.labels).toEqual(["moved-to-jira"]);
    expect(source.closed).toBe(true);

    // Everything done: a third run writes nothing.
    const writes = jira.writes().length;
    expect(await moveToJira(read(), FIELDS, deps())).toEqual({ key: "OA-100", closeWarning: null, linkWarning: null, parentWarning: null });
    expect(jira.writes()).toHaveLength(writes);
    expect(source.comments).toHaveLength(4);
    expect(jira.issues.find((issue) => issue.key === "OA-100")!.comments).toHaveLength(2);
  });

  it("files with the project's default assignee when Jira refuses an unassigned ticket", async () => {
    const jira = fakeJira();
    jira.refuseField("assignee");
    const client = jiraClient(SITE, { email: "bot@example.com", token: "t" }, jira.fetch);
    const moved = await moveToJira({ ref: "OAI-7", comments: [], labels: [], open: false }, FIELDS, {
      jira: client,
      rules,
      write: <T>(call: () => Promise<T>) => call(),
      comment: async () => {},
      addLabel: async () => {},
      close: async () => ({ movedTo: "Movido", warning: null }),
    });
    expect(moved.key).toBe("OA-100");
    const sent = creates(jira).map((call) => "assignee" in (call.body as { fields: Record<string, unknown> }).fields);
    expect(sent).toEqual([true, false]);
  });

  it("files under the configured parent, and at the top level with a warning when Jira refuses it", async () => {
    const jira = fakeJira();
    const client = jiraClient(SITE, { email: "bot@example.com", token: "t" }, jira.fetch);
    const move = (ref: string) =>
      moveToJira({ ref, comments: [], labels: [], open: false }, { ...FIELDS, ref, url: `https://${SITE}/browse/${ref}` }, {
        jira: client,
        rules: { ...rules, parent: "OA-471" },
        write: <T>(call: () => Promise<T>) => call(),
        comment: async () => {},
        addLabel: async () => {},
        close: async () => ({ movedTo: "Movido", warning: null }),
      });
    expect(await move("OAI-7")).toEqual({ key: "OA-100", closeWarning: null, linkWarning: null, parentWarning: null });
    expect(jira.issues.find((issue) => issue.key === "OA-100")!.parent).toBe("OA-471");

    // A closed or deleted parent never stops a move.
    jira.refuseField("parent");
    const moved = await move("OAI-8");
    expect(moved.key).toBe("OA-101");
    expect(moved.parentWarning).toBe("Jira refused OA-471 as its parent; filed at the top level");
    expect(jira.issues.find((issue) => issue.key === "OA-101")!.parent).toBeUndefined();
  });
});
