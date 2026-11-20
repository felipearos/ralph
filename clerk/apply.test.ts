// @vitest-environment node
/**
 * Applying a plan (felipearos/ralph#318): what each decision becomes, and the
 * shadow port's promise — every intended write recorded once, none made.
 * `clerk/gate-apply.test.ts` drives the same apply through the gate against a
 * fake Slack and Jira.
 */
import { describe, expect, it } from "vitest";

import { CLERK_DEFAULTS, type ClerkRules } from "../project-config";
import {
  applyDecisions,
  emptyShadow,
  fieldLines,
  filedIdentity,
  outcomeOf,
  partNote,
  plain,
  RECEIVED_REPLY,
  reportPermalinkOf,
  SAME_REPORT,
  shadowPort,
  TargetGone,
  type Applied,
  type ApplyDeps,
  type Progress,
  type ShadowRecord,
  type WritePort,
} from "./apply";
import { unclassified, validatePlan, type BatchReport, type Candidate, type Decision, type Part } from "./plan";
import { APP_LABELS } from "./fakes";

const RULES: ClerkRules = { ...CLERK_DEFAULTS, appLabels: APP_LABELS, channel: "C0TESTCHAN1", canvas: null, shadowCanvas: "F0SHADOWCV1", operator: null, jira: { site: "example.atlassian.net", project: "OA" } };
const NOW = Date.parse("2026-10-20T12:00:00Z");

const candidate = (key: string, extra: Partial<Candidate> = {}): Candidate => ({
  key,
  summary: "No exporta",
  status: "open",
  closed: null,
  labels: ["slack-intake"],
  jiraKey: null,
  ...extra,
});
const OPEN = candidate("OAI-12");
const CLOSED_RECENTLY = candidate("OAI-7", { status: "Done", closed: "2026-10-15T12:00:00.000Z" });
const CLOSED_LONG_AGO = candidate("OAI-3", { status: "Done", closed: "2026-08-01T12:00:00.000Z" });
/** Closed on the intake board within the window because the sweep moved it to OA, where it is still live. */
const MOVED = candidate("OAI-20", { status: "Done", closed: "2026-10-18T12:00:00.000Z", labels: ["slack-intake", "moved-to-jira"], jiraKey: "OA-12" });
const MOVED_UNKEYED = candidate("OAI-21", { status: "Done", closed: "2026-10-18T12:00:00.000Z", labels: ["slack-intake", "moved-to-jira"] });

const report = (n: number): BatchReport => {
  const id = `176096${n}000.000100`;
  return {
    id,
    author: "U0ANA",
    authorName: "Ana Pérez",
    names: { U0ANA: "Ana Pérez", U0BETO: "Beto" },
    roots: [id],
    messages: [
      { ts: id, user: "U0ANA", text: "No puedo exportar 😡", files: ["https://example.slack.com/files/F1/captura.png"], reply: false, permalink: `https://example.slack.com/archives/C0TESTCHAN1/p${id.replace(".", "")}` },
      { ts: `${id}9`, user: "U0BETO", text: "A mí también", files: [], reply: true, permalink: "https://x/reply" },
    ],
    lastActivity: id,
    permalink: `https://example.slack.com/archives/C0TESTCHAN1/p${id.replace(".", "")}`,
    candidates: [OPEN, CLOSED_RECENTLY, CLOSED_LONG_AGO],
  };
};

const issue = (r: BatchReport, extra: Partial<Extract<Decision, { verdict: "issue" | "decision" }>> = {}): Decision => ({
  report: r.id,
  verdict: "issue",
  type: "Error",
  app: "Backoffice",
  priority: "Medium",
  assignee: "agent",
  difficulty: "medium",
  storyPoints: 3,
  summary: "No se puede exportar el reporte 🚀",
  description: "Al exportar, el archivo sale vacío.",
  duplicate: null,
  unverifiedDuplicate: null,
  ...extra,
});

describe("what each decision becomes", () => {
  const r = report(1);

  it("files a new issue with the intake label, the app's repo label, its difficulty and who does it, quoting the report", () => {
    const outcome = outcomeOf(issue(r), r, RULES, NOW);
    expect(outcome.kind).toBe("create");
    if (outcome.kind !== "create") return;
    expect(outcome.issue).toMatchObject({
      type: "Error",
      priority: "Medium",
      app: "Backoffice",
      assignee: "agent",
      difficulty: "medium",
      storyPoints: 3,
      labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-agente"],
    });
    expect(outcome.issue.description).toContain("Reportado por Ana Pérez en Slack: https://example.slack.com/archives/C0TESTCHAN1/p1760961000000100");
    expect(outcome.issue.description).toContain("> No puedo exportar");
    expect(outcome.issue.description).toContain("> (Beto) A mí también");
    expect(outcome.issue.description).toContain("- https://example.slack.com/files/F1/captura.png");
    expect(outcome.link).toBeNull();
    expect(outcome.reply).toBe(RECEIVED_REPLY);
  });

  it("writes no emoji, whatever the model or the reporter wrote", () => {
    const outcome = outcomeOf(issue(r), r, RULES, NOW);
    if (outcome.kind !== "create") throw new Error("expected a create");
    const written = `${outcome.issue.summary}\n${outcome.issue.description}`;
    expect(written).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(plain("Listo ✅ gracias 🙏🏽 🇨🇱 1️⃣")).toBe("Listo gracias 1");
  });

  it("labels each app with its repo by default, 'none' as backoffice, and por-decidir on a decision at Sin Prioridad", () => {
    const pwa = outcomeOf(issue(r, { app: "pwa" }), r, RULES, NOW);
    expect(pwa.kind === "create" && [pwa.issue.app, pwa.issue.labels]).toEqual(["pwa", ["slack-intake", "acme-pwa", "difficulty:medium", "para-agente"]]);
    const both = outcomeOf(issue(r, { app: "both", assignee: "person" }), r, RULES, NOW);
    expect(both.kind === "create" && both.issue.labels).toEqual(["slack-intake", "acme-backoffice", "acme-pwa", "difficulty:medium", "para-persona"]);
    const decision = outcomeOf(issue(r, { verdict: "decision", type: "Tarea", app: "none", priority: "Sin Prioridad" }), r, RULES, NOW);
    expect(decision.kind === "create" && decision.issue).toMatchObject({
      type: "Tarea",
      priority: "Sin Prioridad",
      app: "none",
      assignee: "person",
      labels: ["slack-intake", "acme-backoffice", "por-decidir", "difficulty:medium", "para-persona"],
    });
  });

  it("labels with each app's repo labels, from the project's appLabels", () => {
    const label = (app: "Backoffice" | "pwa" | "both" | "none") => {
      const outcome = outcomeOf(issue(r, { app, ...(app === "Backoffice" ? {} : { assignee: "person" as const }) }), r, RULES, NOW);
      return outcome.kind === "create" && outcome.issue.labels.slice(0, -2);
    };
    expect(label("Backoffice")).toEqual(["slack-intake", "acme-backoffice"]);
    expect(label("pwa")).toEqual(["slack-intake", "acme-pwa"]);
    expect(label("both")).toEqual(["slack-intake", "acme-backoffice", "acme-pwa"]);
    expect(label("none")).toEqual(["slack-intake", "acme-backoffice"]);
  });

  it("turns a sure duplicate of an open ticket into a comment and a thread reply", () => {
    const outcome = outcomeOf(issue(r, { duplicate: { candidate: OPEN, confidence: "sure" } }), r, RULES, NOW);
    expect(outcome).toMatchObject({ kind: "comment", key: "OAI-12", reply: "Ya está reportado: OAI-12.", instead: { app: "Backoffice", labels: ["slack-intake", "acme-backoffice", "difficulty:medium", "para-agente"] } });
    expect(outcome.kind === "comment" && outcome.comment).toContain("Nuevo reporte del mismo problema por Ana Pérez en Slack");
  });

  it("answers a sure duplicate of a ticket moved to OA with its OA key, and comments on the intake ticket", () => {
    const outcome = outcomeOf(issue(r, { duplicate: { candidate: MOVED, confidence: "sure" } }), r, RULES, NOW);
    expect(outcome).toMatchObject({ kind: "comment", key: "OAI-20", reply: "Ya está reportado: OA-12." });
  });

  it("links the first report of the problem when the ticket names it, so the reporter can read it", () => {
    const original = "https://example.slack.com/archives/C0TESTCHAN1/p1760900000000100";
    const outcome = outcomeOf(issue(r, { duplicate: { candidate: { ...MOVED, permalink: original }, confidence: "sure" } }), r, RULES, NOW);
    expect(outcome).toMatchObject({ kind: "comment", key: "OAI-20", reply: `Ya está reportado: OA-12 (<${original}|reporte original>).` });
  });

  it("reads back the permalink a filed ticket's description carries, and only an https one", () => {
    const filed = outcomeOf(issue(r), r, RULES, NOW);
    expect(filed.kind === "create" && reportPermalinkOf(filed.issue.description)).toBe(r.permalink);
    expect(reportPermalinkOf("Reportado por Ana en Slack: javascript:alert(1)")).toBeNull();
    expect(reportPermalinkOf("Sin línea del reportero.")).toBeNull();
  });

  it("answers with the intake key when a moved ticket's OA key could not be found", () => {
    const outcome = outcomeOf(issue(r, { duplicate: { candidate: MOVED_UNKEYED, confidence: "sure" } }), r, RULES, NOW);
    expect(outcome).toMatchObject({ kind: "comment", key: "OAI-21", reply: "Ya está reportado: OAI-21." });
  });

  it("never files a duplicate of a moved ticket as a regression: unsure, it is a possible duplicate", () => {
    const outcome = outcomeOf(issue(r, { type: "Tarea", duplicate: { candidate: MOVED, confidence: "unsure" } }), r, RULES, NOW);
    expect(outcome.kind === "create" && [outcome.issue.type, outcome.link]).toEqual(["Tarea", { key: "OAI-20", why: "posible duplicado" }]);
    expect(outcome.kind === "create" && outcome.issue.description).toContain("Posible duplicado de OAI-20.");
    expect(outcome.kind === "create" && outcome.issue.description).not.toContain("Posible regresión");
  });

  it("reads a candidate stored in the older shape, with no close time at all, as open", () => {
    const legacy = { key: "OA-12", summary: "No exporta", type: "Error", status: "En curso", statusCategory: "indeterminate", resolved: null, labels: ["slack-intake"] } as unknown as Candidate;
    const outcome = outcomeOf(issue(r, { duplicate: { candidate: legacy, confidence: "sure" } }), r, RULES, NOW);
    expect(outcome).toMatchObject({ kind: "comment", key: "OA-12", reply: "Ya está reportado: OA-12." });
  });

  it("reads a closed candidate stored in the older shape by Jira's done category and resolution date", () => {
    const legacy = { key: "OA-7", summary: "No exporta", type: "Error", status: "Listo", statusCategory: "done", resolved: "2026-10-15T12:00:00Z", labels: ["slack-intake"] } as unknown as Candidate;
    const outcome = outcomeOf(issue(r, { duplicate: { candidate: legacy, confidence: "sure" } }), r, RULES, NOW);
    expect(outcome.kind === "create" && outcome.link).toEqual({ key: "OA-7", why: "posible regresión" });
  });

  it("files a duplicate of a ticket closed within the window as a new Error, linked as a possible regression", () => {
    const outcome = outcomeOf(issue(r, { type: "Tarea", duplicate: { candidate: CLOSED_RECENTLY, confidence: "sure" } }), r, RULES, NOW);
    expect(outcome.kind === "create" && [outcome.issue.type, outcome.link]).toEqual(["Error", { key: "OAI-7", why: "posible regresión" }]);
    expect(outcome.kind === "create" && outcome.issue.description).toContain("Posible regresión de OAI-7");
    // Outside the window it is no regression of anything: a plain new ticket.
    const old = outcomeOf(issue(r, { type: "Tarea", duplicate: { candidate: CLOSED_LONG_AGO, confidence: "sure" } }), r, RULES, NOW);
    expect(old.kind === "create" && [old.issue.type, old.link]).toEqual(["Tarea", null]);
  });

  it("keeps a decision a Tarea even when it matches a recently closed ticket", () => {
    const outcome = outcomeOf(
      issue(r, { verdict: "decision", type: "Tarea", priority: "Sin Prioridad", duplicate: { candidate: CLOSED_RECENTLY, confidence: "sure" } }),
      r,
      RULES,
      NOW,
    );
    expect(outcome.kind === "create" && [outcome.issue.type, outcome.issue.priority, outcome.link]).toEqual([
      "Tarea",
      "Sin Prioridad",
      { key: "OAI-7", why: "posible regresión" },
    ]);
  });

  it("files an unsure duplicate as new, linked as a possible duplicate, never folded into a comment", () => {
    const outcome = outcomeOf(issue(r, { duplicate: { candidate: OPEN, confidence: "unsure" } }), r, RULES, NOW);
    expect(outcome.kind === "create" && outcome.link).toEqual({ key: "OAI-12", why: "posible duplicado" });
    expect(outcome.kind === "create" && outcome.issue.description).toContain("Posible duplicado de OAI-12.");
  });

  it("marks a duplicate the session invented as unverified, with no link to a ticket nobody has seen", () => {
    const outcome = outcomeOf(issue(r, { unverifiedDuplicate: "OA-99" }), r, RULES, NOW);
    expect(outcome.kind === "create" && outcome.link).toBeNull();
    expect(outcome.kind === "create" && outcome.issue.description).toContain("Posible duplicado de OA-99 (no verificado).");
  });

  it("gives every new report the first reply, Highest included, tagging nobody", () => {
    expect(RECEIVED_REPLY).toBe("Recibido, en revisión.");
    expect(plain(RECEIVED_REPLY)).toBe(RECEIVED_REPLY);
    const creates = [
      issue(r, { priority: "Highest" }),
      issue(r, { priority: "Low" }),
      issue(r, { verdict: "decision", type: "Tarea", priority: "Sin Prioridad" }),
      issue(r, { duplicate: { candidate: CLOSED_RECENTLY, confidence: "sure" } }),
      issue(r, { duplicate: { candidate: OPEN, confidence: "unsure" } }),
      issue(r, { type: "Tarea", app: "none", priority: "Sin Prioridad", unclassified: true }),
    ].map((decision) => outcomeOf(decision, r, RULES, NOW));
    expect(creates.map((outcome) => outcome.kind === "create" && outcome.reply)).toEqual(creates.map(() => RECEIVED_REPLY));
    expect(RECEIVED_REPLY).not.toMatch(/<@|<!/);
  });

  it("labels an unclassified report for a person to sort", () => {
    const outcome = outcomeOf(unclassified([r])[0]!, r, RULES, NOW);
    expect(outcome.kind === "create" && outcome.issue.labels).toEqual(["slack-intake", "acme-backoffice", "difficulty:medium", "para-persona", "intake-sin-clasificar"]);
    // Nobody sized it, so the field block names no points.
    expect(outcome.kind === "create" && fieldLines(outcome.issue)).toEqual(["Tipo: Tarea", "Prioridad: Sin Prioridad", "App: none", "Dificultad: medium", "Asignado a: persona"]);
  });

  it("writes the difficulty, the suggested points and who does it in the field block beside type, priority and app", () => {
    const outcome = outcomeOf(issue(r, { difficulty: "hard", storyPoints: 8, assignee: "person" }), r, RULES, NOW);
    if (outcome.kind !== "create") throw new Error("expected a create");
    expect(fieldLines(outcome.issue)).toEqual([
      "Tipo: Error",
      "Prioridad: Medium",
      "App: Backoffice",
      "Dificultad: hard",
      "Puntos de historia sugeridos: 8",
      "Asignado a: persona",
    ]);
  });

  it("ignores with the reason, and nothing else", () => {
    expect(outcomeOf({ report: r.id, verdict: "ignore", reason: "saludo" }, r, RULES, NOW)).toEqual({ kind: "ignore", reason: "saludo" });
  });
});

/** An apply against the shadow port, with the store's bookkeeping kept in memory. */
function shadowRun(record: ShadowRecord = emptyShadow(), state: { progress: Record<string, Progress>; done: Set<string> } = { progress: {}, done: new Set() }) {
  const applied: Applied[] = [];
  let failOn: string | null = null;
  const deps: ApplyDeps = {
    rules: RULES,
    port: shadowPort(record, () => NOW),
    now: () => NOW,
    progress: (id) => state.progress[id] ?? {},
    saveProgress: async (id, progress) => {
      state.progress[id] = progress;
    },
    done: async (one) => {
      if (one.report === failOn) throw new Error("killed before the report was marked done");
      state.done.add(one.report);
      delete state.progress[one.report];
      applied.push(one);
    },
  };
  return {
    record,
    state,
    applied,
    failOn: (id: string | null) => {
      failOn = id;
    },
    run: (decisions: Decision[], reports: BatchReport[]) =>
      applyDecisions(
        decisions.filter((decision) => !state.done.has(decision.report)),
        reports,
        deps,
      ),
  };
}

describe("progress within one report", () => {
  it("redoes only the step a crash interrupted, whatever the port does with a repeat", async () => {
    // A port that counts every call and dedupes nothing: what this proves is
    // the per-step progress, not the shadow port's own bookkeeping.
    const calls: string[] = [];
    let failLinkOnce = true;
    const counting: WritePort = {
      mode: "live",
      findFiled: async () => null,
      hasComment: async () => false,
      hasReply: async () => false,
      copyReply: async () => {},
      create: async () => {
        calls.push("create");
        return "OA-140";
      },
      comment: async () => {
        calls.push("comment");
      },
      relabel: async () => {},
      link: async () => {
        calls.push("link");
        if (failLinkOnce) {
          failLinkOnce = false;
          throw new Error("killed during the link");
        }
      },
      reply: async () => {
        calls.push("reply");
      },
    };
    const r1 = report(1);
    const decision = issue(r1, { priority: "Highest", duplicate: { candidate: OPEN, confidence: "unsure" } });
    const progress: Record<string, Progress> = {};
    const deps: ApplyDeps = {
      rules: RULES,
      port: counting,
      now: () => NOW,
      progress: (id) => progress[id] ?? {},
      saveProgress: async (id, saved) => {
        progress[id] = { ...saved };
      },
      done: async () => {},
    };
    await expect(applyDecisions([decision], [r1], deps)).rejects.toThrow("killed during the link");
    await applyDecisions([decision], [r1], deps);
    // One create, the interrupted link tried twice, one reply.
    expect(calls).toEqual(["create", "link", "link", "reply"]);
  });

  it("files a comment whose target is gone as a new report, with the first reply and not the duplicate's", async () => {
    const writes: string[] = [];
    const port: WritePort = {
      mode: "live",
      findFiled: async () => null,
      hasComment: async () => false,
      hasReply: async () => false,
      copyReply: async () => {},
      create: async (filed) => {
        writes.push(`create ${filed.labels.join(",")}`);
        return "OA-141";
      },
      comment: async (key) => {
        throw new TargetGone(key);
      },
      relabel: async () => {},
      link: async () => {},
      reply: async (_report, text) => {
        writes.push(`reply ${text}`);
      },
    };
    const r1 = report(1);
    const progress: Record<string, Progress> = {};
    const applied = await applyDecisions([issue(r1, { duplicate: { candidate: OPEN, confidence: "sure" } })], [r1], {
      rules: RULES,
      port,
      now: () => NOW,
      progress: (id) => progress[id] ?? {},
      saveProgress: async (id, saved) => {
        progress[id] = { ...saved };
      },
      done: async () => {},
    });
    expect(applied.map((one) => [one.outcome, one.key])).toEqual([["create", "OA-141"]]);
    expect(writes).toEqual(["create slack-intake,acme-backoffice,difficulty:medium,para-agente", `reply ${RECEIVED_REPLY}`]);
  });
});

describe("the shadow port", () => {
  const reports = [report(1), report(2), report(3), report(4), report(5), report(6)];
  const decisions: Decision[] = [
    issue(reports[0]!, { priority: "Highest" }),
    issue(reports[1]!, { duplicate: { candidate: OPEN, confidence: "sure" } }),
    issue(reports[2]!, { duplicate: { candidate: CLOSED_RECENTLY, confidence: "sure" } }),
    issue(reports[3]!, { duplicate: { candidate: OPEN, confidence: "unsure" } }),
    issue(reports[4]!, { verdict: "decision", type: "Tarea", priority: "Sin Prioridad" }),
    { report: reports[5]!.id, verdict: "ignore", reason: "gracias" },
  ];

  it("records one intended write per outcome, and holds no client that could make one", async () => {
    const shadow = shadowRun();
    const applied = await shadow.run(decisions, reports);
    expect(applied.map((one) => one.outcome)).toEqual(["create", "comment", "create", "create", "create", "ignore"]);
    // Every write each outcome comprises, recorded once per report and kind.
    const kinds = (n: number) => shadow.record.writes.filter((entry) => entry.report === reports[n]!.id).map((entry) => entry.write.kind);
    expect(kinds(0)).toEqual(["create", "reply"]);
    expect(kinds(1)).toEqual(["comment", "reply"]);
    expect(kinds(2)).toEqual(["create", "link", "reply"]);
    expect(kinds(3)).toEqual(["create", "link", "reply"]);
    expect(kinds(4)).toEqual(["create", "reply"]);
    // Ignored: nothing written, not even a reply.
    expect(kinds(5)).toEqual([]);
    // The would-be tickets the shadow canvas will show, keyed so nobody takes one for a real key.
    expect(Object.keys(shadow.record.tickets)).toEqual(
      [0, 2, 3, 4].map((n) => `SHADOW-${reports[n]!.id.replace(".", "")}`),
    );
    expect(applied[5]!.line).toContain(`${reports[5]!.permalink} — ignored: gracias`);
    expect(applied[0]!.line).toContain("(shadow: not written)");
    // The port's only state is the record: no fetch, no token, no client.
    expect(Object.keys(shadowPort(emptyShadow(), () => NOW)).sort()).toEqual(["comment", "copyReply", "create", "findFiled", "hasComment", "hasReply", "link", "mode", "relabel", "reply"]);
  });

  it("records each would-be ticket with its difficulty and para-* labels and the field block's two new lines (felipearos/ralph#444)", async () => {
    const shadow = shadowRun();
    await shadow.run(
      [issue(reports[0]!, { difficulty: "easy", storyPoints: 1 }), issue(reports[4]!, { verdict: "decision", type: "Tarea", priority: "Sin Prioridad", difficulty: "hard", storyPoints: 8 })],
      reports,
    );
    const ticket = (n: number) => shadow.record.tickets[`SHADOW-${reports[n]!.id.replace(".", "")}`]!;
    expect(ticket(0)).toMatchObject({ assignee: "agent", difficulty: "easy", storyPoints: 1 });
    expect(ticket(0).labels).toEqual(["slack-intake", "acme-backoffice", "difficulty:easy", "para-agente"]);
    expect(ticket(0).fields).toEqual(expect.arrayContaining(["Dificultad: easy", "Puntos de historia sugeridos: 1"]));
    // A decision is a person's, whatever the decision object says.
    expect(ticket(4)).toMatchObject({ assignee: "person", difficulty: "hard", storyPoints: 8 });
    expect(ticket(4).labels).toEqual(["slack-intake", "acme-backoffice", "por-decidir", "difficulty:hard", "para-persona"]);
    expect(ticket(4).fields).toEqual(expect.arrayContaining(["Dificultad: hard", "Puntos de historia sugeridos: 8", "Asignado a: persona"]));
  });

  it("records nothing twice when a run stopped halfway is run again", async () => {
    const shadow = shadowRun();
    shadow.failOn(reports[2]!.id);
    await expect(shadow.run(decisions, reports)).rejects.toThrow("killed");
    // Two reports done; the third recorded its writes but was never marked done.
    expect([...shadow.state.done]).toEqual([reports[0]!.id, reports[1]!.id]);
    shadow.failOn(null);
    await shadow.run(decisions, reports);
    expect([...shadow.state.done]).toEqual(reports.map((one) => one.id));
    const perReportAndKind = shadow.record.writes.map((entry) => `${entry.report}:${entry.write.kind}`);
    expect(new Set(perReportAndKind).size).toBe(perReportAndKind.length);
    expect(Object.keys(shadow.record.tickets)).toHaveLength(4);
  });
});

describe("a duplicate of an earlier report in the batch", () => {
  /** A live-like port that files OAI-30, OAI-31, … and records every write, deduping nothing but by permalink. */
  function board() {
    const writes: string[] = [];
    const filed = new Map<string, string>();
    let next = 30;
    const port: WritePort = {
      mode: "live",
      findFiled: async (permalink) => filed.get(permalink) ?? null,
      hasComment: async () => false,
      hasReply: async () => false,
      copyReply: async () => {},
      create: async (filedIssue) => {
        const key = `OAI-${next++}`;
        filed.set(filedIssue.permalink, key);
        writes.push(`create ${key}`);
        return key;
      },
      comment: async (key) => {
        writes.push(`comment ${key}`);
      },
      relabel: async () => {},
      link: async (from, to, why) => {
        writes.push(`link ${from} -> ${to} ${why}`);
      },
      reply: async (_report, text) => {
        writes.push(`reply ${text}`);
      },
    };
    const done = new Map<string, string | null>();
    const deps: ApplyDeps = {
      rules: RULES,
      port,
      now: () => NOW,
      progress: () => ({}),
      saveProgress: async () => {},
      done: async (one) => {
        done.set(one.report, one.key);
      },
      finished: (id) => (done.has(id) ? { key: done.get(id)! } : undefined),
    };
    return { writes, deps, done };
  }
  const [a, b, c] = [report(1), report(2), report(3)];

  it("makes a sure one a comment on the ticket the earlier report was filed as", async () => {
    const { writes, deps } = board();
    const applied = await applyDecisions([issue(a), issue(b, { batchDuplicate: { report: a.id, confidence: "sure" } })], [a, b], deps);
    expect(applied.map((one) => [one.outcome, one.key])).toEqual([
      ["create", "OAI-30"],
      ["comment", "OAI-30"],
    ]);
    expect(writes).toEqual(["create OAI-30", `reply ${RECEIVED_REPLY}`, "comment OAI-30", `reply Ya está reportado: OAI-30 (<${a.permalink}|reporte original>).`]);
  });

  it("files an unsure one new, marked \"posible duplicado\" and linked", async () => {
    const { writes, deps } = board();
    const applied = await applyDecisions([issue(a), issue(b, { batchDuplicate: { report: a.id, confidence: "unsure" } })], [a, b], deps);
    expect(applied.map((one) => [one.outcome, one.key])).toEqual([
      ["create", "OAI-30"],
      ["create", "OAI-31"],
    ]);
    expect(writes).toContain("link OAI-31 -> OAI-30 posible duplicado");
    expect(applied[1]!.issue!.description).toContain("Posible duplicado de OAI-30.");
  });

  it("follows an earlier report that was itself a comment to the ticket it joined, OA key and all", async () => {
    const { writes, deps } = board();
    const applied = await applyDecisions(
      [issue(a, { duplicate: { candidate: MOVED, confidence: "sure" } }), issue(b, { batchDuplicate: { report: a.id, confidence: "sure" } })],
      [a, b],
      deps,
    );
    expect(applied.map((one) => [one.outcome, one.key])).toEqual([
      ["comment", "OAI-20"],
      ["comment", "OAI-20"],
    ]);
    expect(writes.filter((write) => write.startsWith("reply"))).toEqual(["reply Ya está reportado: OA-12.", "reply Ya está reportado: OA-12."]);
  });

  it("resolves a validated chain to its root", async () => {
    const entry = (r: BatchReport, extra: Record<string, unknown> = {}) => ({
      report: r.id,
      verdict: "issue",
      type: "Error",
      app: "Backoffice",
      priority: "Medium",
      assignee: "agent",
      difficulty: "medium",
      story_points: 3,
      summary_es: "x",
      description_es: "y",
      ...extra,
    });
    const validated = validatePlan(
      { batch: "b", entries: [entry(a), entry(b, { duplicate_of: a.id, duplicate_confidence: "sure" }), entry(c, { duplicate_of: b.id, duplicate_confidence: "sure" })] },
      "b",
      [a, b, c], { apps: APP_LABELS },
    );
    if (!validated.ok) throw new Error(validated.problems.join("; "));
    const { deps } = board();
    const applied = await applyDecisions(validated.decisions, [a, b, c], deps);
    expect(applied.map((one) => [one.outcome, one.key])).toEqual([
      ["create", "OAI-30"],
      ["comment", "OAI-30"],
      ["comment", "OAI-30"],
    ]);
  });

  it("files a report whose earlier report has no ticket new, naming that report", async () => {
    const { deps } = board();
    const applied = await applyDecisions(
      [{ report: a.id, verdict: "ignore", reason: "saludo" }, issue(b, { batchDuplicate: { report: a.id, confidence: "sure" } })],
      [a, b],
      deps,
    );
    expect(applied.map((one) => [one.outcome, one.key])).toEqual([
      ["ignore", null],
      ["create", "OAI-30"],
    ]);
    expect(applied[1]!.issue!.description).toContain(`Posible duplicado de ${a.permalink} (no verificado).`);
  });

  it("finds the earlier report's ticket on a rerun, and files nothing twice", async () => {
    const { writes, deps, done } = board();
    const decisions = [issue(a), issue(b, { batchDuplicate: { report: a.id, confidence: "sure" } })];
    let kill = true;
    const killing: ApplyDeps = {
      ...deps,
      done: async (one) => {
        if (one.report === b.id && kill) throw new Error("killed before the report was marked done");
        await deps.done(one);
      },
    };
    await expect(applyDecisions(decisions, [a, b], killing)).rejects.toThrow("killed");
    kill = false;
    // The first report is finished: skipped, and still the second's target.
    const applied = await applyDecisions(decisions, [a, b], killing);
    expect(applied.map((one) => [one.report, one.outcome, one.key])).toEqual([[b.id, "comment", "OAI-30"]]);
    expect(writes.filter((write) => write.startsWith("create"))).toEqual(["create OAI-30"]);
    expect(done.get(b.id)).toBe("OAI-30");
    // And a third run does nothing at all.
    expect(await applyDecisions(decisions, [a, b], killing)).toEqual([]);
  });
});

describe("a report of several problems, split into tickets", () => {
  // OAI-29: one report, four bugs in a PDF. Each problem is its own ticket,
  // numbered, linked to the report's, and found again by its own identity.
  const r = report(7);
  const part = (summary: string, extra: Partial<Part> = {}): Part => ({
    type: "Error",
    app: "pwa",
    priority: "Low",
    assignee: "agent",
    difficulty: "easy",
    storyPoints: 2,
    summary,
    description: `${summary}.`,
    duplicate: null,
    unverifiedDuplicate: null,
    ...extra,
  });
  const split = issue(r, { parts: [part("Fechas vacías en Tareas"), part("La barra de estado tapa Preferencias", { duplicate: OPEN })] });

  /** A board that finds a ticket by what it was filed as, the way the live port's marker does. */
  function board(failOnce: string | null = null) {
    const filed = new Map<string, string>();
    const writes: string[] = [];
    let next = 70;
    let fail = failOnce;
    const port: WritePort = {
      mode: "live",
      findFiled: async (identity) => filed.get(identity) ?? null,
      hasComment: async () => false,
      hasReply: async () => writes.includes("reply"),
      copyReply: async () => {},
      create: async (one) => {
        const key = `OAI-${next++}`;
        filed.set(filedIdentity(one), key);
        writes.push(`create ${key}`);
        return key;
      },
      comment: async (key) => {
        writes.push(`comment ${key}`);
      },
      relabel: async () => {},
      link: async (from, to, why) => {
        const write = `link ${from} ${to} ${why}`;
        if (write === fail) {
          fail = null;
          throw new Error("killed during a part's link");
        }
        writes.push(write);
      },
      reply: async () => {
        writes.push("reply");
      },
    };
    const progress: Record<string, Progress> = {};
    const deps: ApplyDeps = {
      rules: RULES,
      port,
      now: () => NOW,
      progress: (id) => progress[id] ?? {},
      saveProgress: async (id, saved) => {
        progress[id] = structuredClone(saved);
      },
      done: async () => {},
    };
    return { writes, deps };
  }

  it("files each problem as its own numbered ticket, linked to the report's, a part's candidate marked as a likely duplicate", async () => {
    const outcome = outcomeOf(split, r, RULES, NOW);
    expect(outcome.kind).toBe("create");
    if (outcome.kind !== "create") return;
    expect(outcome.issue.description).toContain(partNote(1, 3));
    expect(outcome.issue).not.toHaveProperty("part");
    expect(outcome.parts.map((one) => [one.issue.part, one.issue.summary, one.issue.labels, one.link])).toEqual([
      [2, "Fechas vacías en Tareas", ["slack-intake", "acme-pwa", "difficulty:easy", "para-agente"], null],
      [3, "La barra de estado tapa Preferencias", ["slack-intake", "acme-pwa", "difficulty:easy", "para-agente", "posible-duplicado"], { key: "OAI-12", why: "posible duplicado" }],
    ]);
    expect(outcome.parts[1]!.issue.description).toContain(partNote(3, 3));
    expect(outcome.parts[1]!.issue.description).toContain("Posible duplicado de OAI-12.");
    // Every ticket names the report it came from; each part is filed under its own identity.
    expect(outcome.parts[0]!.issue.description).toContain(`Reportado por Ana Pérez en Slack: ${r.permalink}`);
    expect(filedIdentity(outcome.parts[0]!.issue)).toBe(`${r.permalink}#parte-2`);
    expect(filedIdentity(outcome.issue)).toBe(r.permalink);

    const { writes, deps } = board();
    const [applied] = await applyDecisions([split], [r], deps);
    expect(writes).toEqual([
      "create OAI-70",
      "create OAI-71",
      `link OAI-71 OAI-70 ${SAME_REPORT}`,
      "create OAI-72",
      `link OAI-72 OAI-70 ${SAME_REPORT}`,
      "link OAI-72 OAI-12 posible duplicado",
      "reply",
    ]);
    expect(applied!.key).toBe("OAI-70");
    expect(applied!.parts!.map((one) => one.key)).toEqual(["OAI-71", "OAI-72"]);
    expect(applied!.line).toContain("split: also OAI-71, OAI-72");
  });

  it("redoes only what a crash interrupted, and files no problem twice", async () => {
    const { writes, deps } = board(`link OAI-72 OAI-70 ${SAME_REPORT}`);
    await expect(applyDecisions([split], [r], deps)).rejects.toThrow("killed during a part's link");
    await applyDecisions([split], [r], deps);
    expect(writes.filter((write) => write.startsWith("create"))).toEqual(["create OAI-70", "create OAI-71", "create OAI-72"]);
    expect(writes.filter((write) => write.startsWith("link OAI-71"))).toHaveLength(1);
    expect(writes.filter((write) => write === "reply")).toHaveLength(1);
  });

  it("files the other problems of a report whose first is a sure duplicate, linked to that ticket", async () => {
    const { writes, deps } = board();
    const [applied] = await applyDecisions([{ ...split, duplicate: { candidate: OPEN, confidence: "sure" } } as Decision], [r], deps);
    expect(applied!.outcome).toBe("comment");
    expect(writes.slice(0, 3)).toEqual(["comment OAI-12", "create OAI-70", `link OAI-70 OAI-12 ${SAME_REPORT}`]);
    expect(applied!.parts!.map((one) => one.key)).toEqual(["OAI-70", "OAI-71"]);
  });

  it("records each part apart in shadow, under a key of its own", async () => {
    const shadow = shadowRun();
    await shadow.run([split], [r]);
    const own = `SHADOW-${r.id.replace(".", "")}`;
    expect(Object.keys(shadow.record.tickets)).toEqual([own, `${own}-2`, `${own}-3`]);
    expect(shadow.record.writes.filter((entry) => entry.write.kind === "create")).toHaveLength(3);
    expect(shadow.record.writes.filter((entry) => entry.write.kind === "link")).toHaveLength(3);
    // A rerun finds every ticket and records nothing new.
    const before = shadow.record.writes.length;
    shadow.state.done.clear();
    await shadow.run([split], [r]);
    expect(shadow.record.writes).toHaveLength(before);
    expect(Object.keys(shadow.record.tickets)).toHaveLength(3);
  });
});

describe("relabelling an original a duplicate of which must go to a person", () => {
  const OF_AGENT = candidate("OAI-12", { labels: ["slack-intake", "para-agente"] });

  it("carries the plan's relabel onto a create and a comment", () => {
    const r = report(1);
    expect(outcomeOf(issue(r, { duplicate: { candidate: OF_AGENT, confidence: "unsure" }, relabel: ["OAI-12"] }), r, RULES, NOW)).toMatchObject({ kind: "create", relabel: ["OAI-12"] });
    expect(outcomeOf(issue(r, { duplicate: { candidate: OF_AGENT, confidence: "sure" }, relabel: ["OAI-12"] }), r, RULES, NOW)).toMatchObject({ kind: "comment", relabel: ["OAI-12"] });
    expect(outcomeOf(issue(r), r, RULES, NOW)).toMatchObject({ kind: "create", relabel: [] });
  });

  it("moves each original from para-agente to para-persona once, a rerun skipping it and a gone one dropped", async () => {
    const r = report(1);
    const saved: Progress[] = [];
    let progress: Progress = {};
    const relabelled: string[] = [];
    const port: WritePort = {
      mode: "live",
      findFiled: async () => null,
      hasComment: async () => false,
      hasReply: async () => false,
      copyReply: async () => {},
      create: async () => "OAI-40",
      comment: async () => {},
      relabel: async (key) => {
        if (key === "OAI-404") throw new TargetGone(key);
        relabelled.push(key);
      },
      link: async () => {},
      reply: async () => {},
    };
    const deps: ApplyDeps = {
      rules: RULES,
      port,
      now: () => NOW,
      progress: () => progress,
      saveProgress: async (_id, next) => {
        progress = { ...next };
        saved.push(progress);
      },
      done: async () => {},
    };
    const decision = issue(r, { duplicate: { candidate: OF_AGENT, confidence: "unsure" }, relabel: ["OAI-404", "OAI-12"] });
    const [applied] = await applyDecisions([decision], [r], deps);
    expect(relabelled).toEqual(["OAI-12"]);
    expect(applied!.writes).toContainEqual({ kind: "relabel", key: "OAI-12", add: "para-persona", remove: "para-agente" });
    expect(applied!.line).toContain("OAI-404, OAI-12 relabelled 'para-persona'");
    expect(progress.relabelled).toEqual(["OAI-404", "OAI-12"]);
    await applyDecisions([decision], [r], deps);
    expect(relabelled).toEqual(["OAI-12"]);
  });

  it("is recorded, not made, by the shadow port", async () => {
    const record = emptyShadow();
    await shadowPort(record, () => NOW).relabel("OAI-12", report(1));
    expect(record.writes.map((entry) => entry.write)).toEqual([{ kind: "relabel", key: "OAI-12", add: "para-persona", remove: "para-agente" }]);
  });
});
