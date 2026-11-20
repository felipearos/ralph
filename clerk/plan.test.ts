// @vitest-environment node
/**
 * The plan validator (felipearos/ralph#318): the boundary between what the
 * session wrote and every write code makes. Each case is one way a plan can be
 * wrong, and what the validator does about it.
 */
import { describe, expect, it } from "vitest";

import { unclassified, validatePlan, type BatchReport, type Candidate } from "./plan";
import { APP_LABELS } from "./fakes";

const OPEN: Candidate = { key: "OA-12", summary: "No exporta", status: "open", closed: null, labels: ["slack-intake"], jiraKey: null };

const report = (id: string, candidates: Candidate[] = [OPEN]): BatchReport => ({
  id,
  author: "U0ANA",
  authorName: "Ana",
  names: { U0ANA: "Ana" },
  roots: [id],
  messages: [{ ts: id, user: "U0ANA", text: "No puedo exportar", files: [], reply: false, permalink: `https://x/p${id}` }],
  lastActivity: id,
  permalink: `https://x/p${id}`,
  candidates,
});

const BATCH = "batch-1.000100";
const REPORTS = [report("1.000100"), report("2.000100")];

const issue = (id: string, extra: Record<string, unknown> = {}) => ({
  report: id,
  verdict: "issue",
  type: "Error",
  app: "Backoffice",
  priority: "High",
  assignee: "agent",
  difficulty: "medium",
  story_points: 3,
  duplicate_of: null,
  summary_es: "No se puede exportar el reporte de checklists",
  description_es: "Al exportar, el archivo sale vacío.",
  ...extra,
});

describe("a valid plan", () => {
  it("passes, in batch order whatever order it was written in", () => {
    const validated = validatePlan(
      { batch: BATCH, entries: [{ report: "2.000100", verdict: "ignore", ignore_reason: "agradecimiento" }, issue("1.000100")] },
      BATCH,
      REPORTS, { apps: APP_LABELS },
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.decisions.map((decision) => decision.report)).toEqual(["1.000100", "2.000100"]);
    expect(validated.decisions[0]).toMatchObject({ verdict: "issue", type: "Error", app: "Backoffice", priority: "High", duplicate: null, unverifiedDuplicate: null });
    expect(validated.decisions[1]).toEqual({ report: "2.000100", verdict: "ignore", reason: "agradecimiento" });
  });

  it("makes a decision a Tarea at Sin Prioridad, whether the session said so or not", () => {
    const validated = validatePlan(
      {
        batch: BATCH,
        entries: [
          { report: "1.000100", verdict: "decision", app: "pwa", difficulty: "easy", story_points: 1, summary_es: "Definir el comportamiento del breadcrumb", description_es: "Funciona como está diseñado." },
          { report: "2.000100", verdict: "decision", type: "Tarea", priority: "Sin Prioridad", app: "none", assignee: "person", difficulty: "hard", story_points: 8, summary_es: "x", description_es: "y" },
        ],
      },
      BATCH,
      REPORTS, { apps: APP_LABELS },
    );
    expect(
      validated.ok && validated.decisions.map((decision) => decision.verdict !== "ignore" && [decision.type, decision.priority, decision.assignee, decision.difficulty, decision.storyPoints]),
    ).toEqual([
      ["Tarea", "Sin Prioridad", "person", "easy", 1],
      ["Tarea", "Sin Prioridad", "person", "hard", 8],
    ]);
  });

  it("carries a duplicate the report was offered, with its confidence", () => {
    const validated = validatePlan(
      { batch: BATCH, entries: [issue("1.000100", { duplicate_of: "OA-12", duplicate_confidence: "sure" }), issue("2.000100")] },
      BATCH,
      REPORTS, { apps: APP_LABELS },
    );
    expect(validated.ok && validated.decisions[0]!.verdict === "issue" && validated.decisions[0]!.duplicate).toEqual({ candidate: OPEN, confidence: "sure" });
  });
});

describe("an invalid plan", () => {
  const problems = (raw: unknown): string[] => {
    const validated = validatePlan(raw, BATCH, REPORTS, { apps: APP_LABELS });
    expect(validated.ok).toBe(false);
    return validated.ok ? [] : validated.problems;
  };

  it("is refused for an unknown enum value, each one named", () => {
    expect(problems({ batch: BATCH, entries: [issue("1.000100", { priority: "Lowest" }), issue("2.000100", { verdict: "bug" })] })).toEqual([
      "entries[0] (report 1.000100).priority must be one of Highest, High, Medium, Low, Sin Prioridad; got \"Lowest\"",
      "entries[1] (report 2.000100).verdict must be one of issue, decision, ignore; got \"bug\"",
    ]);
    expect(problems({ batch: BATCH, entries: [issue("1.000100", { app: "android" }), issue("2.000100", { type: "Historia" })] })).toHaveLength(2);
    expect(problems({ batch: BATCH, entries: [issue("1.000100", { duplicate_of: "OA-12", duplicate_confidence: "maybe" }), issue("2.000100")] })).toEqual([
      "entries[0] (report 1.000100).duplicate_confidence must be one of sure, unsure; got \"maybe\"",
    ]);
    // A decision may not be filed as a High Error: both the type and the priority are refused.
    expect(problems({ batch: BATCH, entries: [issue("1.000100", { verdict: "decision", priority: "High", assignee: null }), issue("2.000100")] })).toEqual([
      'entries[0] (report 1.000100).type must be one of Tarea; got "Error"',
      'entries[0] (report 1.000100).priority must be one of Sin Prioridad; got "High"',
    ]);
  });

  it("is refused for a missing field, and for a report left out", () => {
    const { summary_es: _summary, ...noSummary } = issue("1.000100");
    expect(problems({ batch: BATCH, entries: [noSummary, issue("2.000100")] })).toEqual([
      "entries[0] (report 1.000100).summary_es must be a one-line summary in Spanish",
    ]);
    expect(problems({ batch: BATCH, entries: [{ report: "1.000100", verdict: "ignore" }, issue("2.000100")] })).toEqual([
      "entries[0] (report 1.000100).ignore_reason must say in one line why this is not a report",
    ]);
    expect(problems({ batch: BATCH, entries: [issue("1.000100")] })).toEqual(["report 2.000100 has no entry; every report in the batch needs one"]);
    expect(problems({ batch: "batch-other", entries: [issue("1.000100"), issue("2.000100")] })[0]).toContain("'batch' must be 'batch-1.000100'");
    expect(problems({ batch: BATCH, entries: [issue("1.000100"), issue("1.000100"), issue("2.000100")] })).toEqual(["entries[1].report 1.000100 has a second entry"]);
    expect(problems({ batch: BATCH, entries: [issue("9.000100"), issue("1.000100"), issue("2.000100")] })[0]).toContain("must be the id of a report in this batch");
    expect(problems({ batch: BATCH, entries: [issue("1.000100", { summary_es: "dos\nlíneas" }), issue("2.000100")] })).toHaveLength(1);
    expect(problems({ batch: BATCH, entries: [issue("1.000100", { summary_es: "x".repeat(256) }), issue("2.000100")] })[0]).toContain("at most 255");
  });

  it("is refused when it is not a plan at all", () => {
    expect(problems("no plan at .ralph/logs/clerk-plan-batch-1.000100.json")).toEqual(["no plan at .ralph/logs/clerk-plan-batch-1.000100.json"]);
    expect(problems([])).toEqual(["the plan must be a JSON object with 'batch' and 'entries'"]);
    expect(problems({ batch: BATCH })).toEqual(["'entries' must be an array with one entry per report"]);
  });
});

describe("assignee, difficulty and story points (felipearos/ralph#444)", () => {
  const problems = (raw: unknown): string[] => {
    const validated = validatePlan(raw, BATCH, REPORTS, { apps: APP_LABELS });
    return validated.ok ? [] : validated.problems;
  };
  const without = (field: string): Record<string, unknown> => {
    const entry: Record<string, unknown> = { ...issue("1.000100") };
    delete entry[field];
    return entry;
  };

  it("carries all three onto the decision", () => {
    const validated = validatePlan({ batch: BATCH, entries: [issue("1.000100", { difficulty: "hard", story_points: 5 }), issue("2.000100")] }, BATCH, REPORTS, { apps: APP_LABELS });
    expect(validated.ok && validated.decisions[0]).toMatchObject({ assignee: "agent", difficulty: "hard", storyPoints: 5 });
    expect(validated.ok && validated.notes).toEqual([]);
  });

  it("refuses an issue without any one of them, naming the field and the allowed values", () => {
    expect(problems({ batch: BATCH, entries: [without("difficulty"), issue("2.000100")] })).toEqual([
      "entries[0] (report 1.000100).difficulty must be one of easy, medium, hard; got undefined",
    ]);
    expect(problems({ batch: BATCH, entries: [without("story_points"), issue("2.000100")] })).toEqual([
      "entries[0] (report 1.000100).story_points must be one of 1, 2, 3, 5, 8, as a number; got undefined",
    ]);
    expect(problems({ batch: BATCH, entries: [without("assignee"), issue("2.000100")] })).toEqual([
      "entries[0] (report 1.000100).assignee must be one of agent, person; got undefined",
    ]);
  });

  it("refuses a decision without difficulty or points, and one for an agent", () => {
    const decision = { report: "1.000100", verdict: "decision", app: "none", summary_es: "x", description_es: "y" };
    expect(problems({ batch: BATCH, entries: [decision, issue("2.000100")] })).toEqual([
      "entries[0] (report 1.000100).difficulty must be one of easy, medium, hard; got undefined",
      "entries[0] (report 1.000100).story_points must be one of 1, 2, 3, 5, 8, as a number; got undefined",
    ]);
    expect(problems({ batch: BATCH, entries: [{ ...decision, difficulty: "easy", story_points: 2, assignee: "agent" }, issue("2.000100")] })).toEqual([
      'entries[0] (report 1.000100).assignee must be one of person; got "agent"',
    ]);
  });

  it("takes only the Fibonacci points 1, 2, 3, 5 and 8, as numbers", () => {
    for (const points of [1, 2, 3, 5, 8]) {
      expect(problems({ batch: BATCH, entries: [issue("1.000100", { story_points: points }), issue("2.000100")] }), `points ${points}`).toEqual([]);
    }
    for (const points of [4, "3", 0, 13, 2.5, null]) {
      expect(problems({ batch: BATCH, entries: [issue("1.000100", { story_points: points }), issue("2.000100")] }), `points ${JSON.stringify(points)}`).toEqual([
        `entries[0] (report 1.000100).story_points must be one of 1, 2, 3, 5, 8, as a number; got ${JSON.stringify(points)}`,
      ]);
    }
  });

  it("refuses an unknown difficulty or assignee", () => {
    expect(problems({ batch: BATCH, entries: [issue("1.000100", { difficulty: "trivial", assignee: "bot" }), issue("2.000100")] })).toEqual([
      'entries[0] (report 1.000100).assignee must be one of agent, person; got "bot"',
      'entries[0] (report 1.000100).difficulty must be one of easy, medium, hard; got "trivial"',
    ]);
  });

  it("sends a Highest, a both-apps or a pwa report to a person with a note, and never refuses the plan for it", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ priority: "Highest" }, "Prioridad Highest: la revisa una persona."],
      [{ app: "both" }, "Afecta a las dos apps, backoffice y pwa."],
      [{ app: "pwa" }, "No hay un proyecto de agentes para acme-pwa."],
    ];
    for (const [extra, reason] of cases) {
      const validated = validatePlan({ batch: BATCH, entries: [issue("1.000100", extra), issue("2.000100")] }, BATCH, REPORTS, { apps: APP_LABELS });
      expect(validated.ok, JSON.stringify(extra)).toBe(true);
      if (!validated.ok) continue;
      expect(validated.decisions.map((decision) => decision.verdict !== "ignore" && decision.assignee)).toEqual(["person", "agent"]);
      expect(validated.notes).toEqual([`report 1.000100: assignee "agent" changed to "person": ${reason}`]);
    }
  });

  it("leaves a pwa report with an agent when a pwa agent project exists, and a person's entry without a note", () => {
    const pwa = validatePlan({ batch: BATCH, entries: [issue("1.000100", { app: "pwa" }), issue("2.000100")] }, BATCH, REPORTS, { pwaAgents: true, apps: APP_LABELS });
    expect(pwa.ok && pwa.decisions[0]).toMatchObject({ assignee: "agent" });
    expect(pwa.ok && pwa.notes).toEqual([]);
    const person = validatePlan({ batch: BATCH, entries: [issue("1.000100", { priority: "Highest", assignee: "person" }), issue("2.000100")] }, BATCH, REPORTS, { apps: APP_LABELS });
    expect(person.ok && person.notes).toEqual([]);
  });
});

describe("an invented duplicate_of", () => {
  it("downgrades that entry to a new ticket marked possible duplicate, and does not fail the plan", () => {
    const validated = validatePlan(
      // OA-99 was offered to nobody; OA-12 was offered, but not to report 2.
      { batch: BATCH, entries: [issue("1.000100", { duplicate_of: "OA-99", duplicate_confidence: "sure" }), issue("2.000100", { duplicate_of: "OA-12", duplicate_confidence: "sure" })] },
      BATCH,
      [report("1.000100"), report("2.000100", [])],
      { apps: APP_LABELS },
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.decisions.map((decision) => decision.verdict !== "ignore" && [decision.duplicate, decision.unverifiedDuplicate])).toEqual([
      [null, "OA-99"],
      [null, "OA-12"],
    ]);
    expect(validated.notes).toEqual([
      'report 1.000100: duplicate_of "OA-99" was not among its candidates; filed new, marked "posible duplicado"',
      'report 2.000100: duplicate_of "OA-12" was not among its candidates; filed new, marked "posible duplicado"',
    ]);
  });
});

describe("a downgraded duplicate_of", () => {
  it("needs no confidence, and is named in the ticket only when it looks like a key", () => {
    const validated = validatePlan(
      { batch: BATCH, entries: [issue("1.000100", { duplicate_of: "OA-99" }), issue("2.000100", { duplicate_of: "ver el ticket del lunes\nOA-1" })] },
      BATCH,
      REPORTS, { apps: APP_LABELS },
    );
    expect(validated.ok && validated.decisions.map((decision) => decision.verdict !== "ignore" && decision.unverifiedDuplicate)).toEqual(["OA-99", null]);
  });

  it("coerces an explicit null type, priority or assignee on a decision", () => {
    const validated = validatePlan(
      { batch: BATCH, entries: [issue("1.000100", { verdict: "decision", type: null, priority: null, assignee: null }), issue("2.000100")] },
      BATCH,
      REPORTS, { apps: APP_LABELS },
    );
    expect(validated.ok && validated.decisions[0]!.verdict === "decision" && [validated.decisions[0]!.type, validated.decisions[0]!.priority]).toEqual(["Tarea", "Sin Prioridad"]);
  });
});

describe("a report a person asked to have filed (felipearos/ralph#323)", () => {
  it("may not be ignored again, and may be anything else", () => {
    const hinted = [{ ...report("1.000100"), hint: "Carla" }, report("2.000100")];
    const refused = validatePlan(
      { batch: BATCH, entries: [{ report: "1.000100", verdict: "ignore", ignore_reason: "saludo" }, issue("2.000100")] },
      BATCH,
      hinted, { apps: APP_LABELS },
    );
    expect(refused).toEqual({
      ok: false,
      problems: ['entries[0] (report 1.000100).verdict may not be "ignore": Carla said in its thread that this is a report, so it is an issue or a decision'],
    });
    expect(validatePlan({ batch: BATCH, entries: [issue("1.000100"), issue("2.000100")] }, BATCH, hinted, { apps: APP_LABELS }).ok).toBe(true);
    // The other report in the batch may still be ignored.
    expect(validatePlan({ batch: BATCH, entries: [issue("1.000100"), { report: "2.000100", verdict: "ignore", ignore_reason: "saludo" }] }, BATCH, hinted, { apps: APP_LABELS }).ok).toBe(true);
  });
});

describe("the fallback after a second invalid plan", () => {
  it("files every report as an unclassified Tarea at Sin Prioridad", () => {
    expect(unclassified(REPORTS)).toEqual(
      REPORTS.map((one) => ({
        report: one.id,
        verdict: "issue",
        type: "Tarea",
        app: "none",
        priority: "Sin Prioridad",
        assignee: "person",
        difficulty: "medium",
        storyPoints: null,
        summary: "Reporte sin clasificar de Ana: No puedo exportar",
        description: "El clerk no pudo clasificar este reporte. Revisar y clasificar a mano.",
        duplicate: null,
        unverifiedDuplicate: null,
        unclassified: true,
      })),
    );
  });
});

describe("a duplicate of an earlier report in the batch", () => {
  // Oldest first, as the gate hands them over. The board candidates were read
  // before any of them was filed, so they never hold one another.
  const THREE = [report("1.000100"), report("2.000100"), report("3.000100")];
  const BATCH3 = "batch-3";
  const validate = (entries: unknown[]) => validatePlan({ batch: BATCH3, entries }, BATCH3, THREE, { apps: APP_LABELS });
  const decisionOf = (validated: ReturnType<typeof validate>, id: string) => (validated.ok ? validated.decisions.find((decision) => decision.report === id) : undefined);

  it("carries an earlier report, sure or unsure, for the apply to resolve", () => {
    const validated = validate([
      issue("1.000100"),
      issue("2.000100", { duplicate_of: "1.000100", duplicate_confidence: "sure" }),
      issue("3.000100", { duplicate_of: "1.000100", duplicate_confidence: "unsure" }),
    ]);
    expect(validated.ok).toBe(true);
    expect(decisionOf(validated, "1.000100")).not.toHaveProperty("batchDuplicate");
    expect(decisionOf(validated, "2.000100")).toMatchObject({ duplicate: null, unverifiedDuplicate: null, batchDuplicate: { report: "1.000100", confidence: "sure" } });
    expect(decisionOf(validated, "3.000100")).toMatchObject({ batchDuplicate: { report: "1.000100", confidence: "unsure" } });
    expect(validated.ok && validated.notes).toEqual([]);
  });

  it("still needs a confidence", () => {
    const validated = validate([issue("1.000100"), issue("2.000100", { duplicate_of: "1.000100" }), issue("3.000100")]);
    expect(validated.ok ? [] : validated.problems).toEqual(["entries[1] (report 2.000100).duplicate_confidence must be one of sure, unsure; got undefined"]);
  });

  it("resolves a chain to its root, sure only when every link is", () => {
    const sure = validate([
      issue("1.000100"),
      issue("2.000100", { duplicate_of: "1.000100", duplicate_confidence: "sure" }),
      issue("3.000100", { duplicate_of: "2.000100", duplicate_confidence: "sure" }),
    ]);
    expect(decisionOf(sure, "3.000100")).toMatchObject({ batchDuplicate: { report: "1.000100", confidence: "sure" } });
    // Written in reverse: the order of the entries is not the batch's.
    const doubtful = validate([
      issue("3.000100", { duplicate_of: "2.000100", duplicate_confidence: "sure" }),
      issue("2.000100", { duplicate_of: "1.000100", duplicate_confidence: "unsure" }),
      issue("1.000100"),
    ]);
    expect(decisionOf(doubtful, "3.000100")).toMatchObject({ batchDuplicate: { report: "1.000100", confidence: "unsure" } });
  });

  it("downgrades a later report, the report itself, an unknown id and an ignored report to a new ticket", () => {
    const later = validate([
      issue("1.000100", { duplicate_of: "3.000100", duplicate_confidence: "sure" }),
      issue("2.000100", { duplicate_of: "2.000100", duplicate_confidence: "sure" }),
      issue("3.000100"),
    ]);
    expect(later.ok).toBe(true);
    // The later one is named in the ticket for whoever confirms it; the report itself is not.
    expect(decisionOf(later, "1.000100")).toMatchObject({ duplicate: null, unverifiedDuplicate: "https://x/p3.000100" });
    expect(decisionOf(later, "1.000100")).not.toHaveProperty("batchDuplicate");
    expect(decisionOf(later, "2.000100")).toMatchObject({ duplicate: null, unverifiedDuplicate: null });
    expect(decisionOf(later, "2.000100")).not.toHaveProperty("batchDuplicate");
    expect(later.ok && later.notes).toEqual([
      'report 1.000100: duplicate_of "3.000100" is a later report of the batch; filed new, marked "posible duplicado"',
      'report 2.000100: duplicate_of "2.000100" is the report itself; filed new',
    ]);

    const unknown = validate([issue("1.000100"), issue("2.000100", { duplicate_of: "9.000100", duplicate_confidence: "sure" }), issue("3.000100")]);
    expect(decisionOf(unknown, "2.000100")).toMatchObject({ duplicate: null, unverifiedDuplicate: null });
    expect(unknown.ok && unknown.notes).toEqual(['report 2.000100: duplicate_of "9.000100" was not among its candidates; filed new']);

    const ignored = validate([
      { report: "1.000100", verdict: "ignore", ignore_reason: "saludo" },
      issue("2.000100", { duplicate_of: "1.000100", duplicate_confidence: "sure" }),
      issue("3.000100", { duplicate_of: "2.000100", duplicate_confidence: "sure" }),
    ]);
    expect(decisionOf(ignored, "2.000100")).toMatchObject({ unverifiedDuplicate: "https://x/p1.000100" });
    expect(decisionOf(ignored, "2.000100")).not.toHaveProperty("batchDuplicate");
    // The chain stops at the report that was downgraded: it is the root now.
    expect(decisionOf(ignored, "3.000100")).toMatchObject({ batchDuplicate: { report: "2.000100", confidence: "sure" } });
    expect(ignored.ok && ignored.notes).toEqual(['report 2.000100: duplicate_of 1.000100 is a report this plan ignores; filed new, marked "posible duplicado"']);
  });
});

describe("a report of several problems (additional_issues)", () => {
  // OAI-29: "Pille 4 cosas" and a PDF of four bugs, filed as one ticket for a
  // person to split by hand.
  const part = (extra: Record<string, unknown> = {}) => ({
    type: "Error",
    app: "pwa",
    priority: "Low",
    assignee: "agent",
    difficulty: "easy",
    story_points: 2,
    summary_es: "En Preferencias la barra de estado tapa el encabezado",
    description_es: "Problema 3 de 4 del PDF.",
    ...extra,
  });

  it("carries each other problem as a part, checked like an issue, a pwa agent sent to a person with a note", () => {
    const validated = validatePlan(
      { batch: BATCH, entries: [issue("1.000100", { additional_issues: [part(), part({ priority: "High", assignee: "person", difficulty: "hard", story_points: 5 })] }), issue("2.000100")] },
      BATCH,
      REPORTS, { apps: APP_LABELS },
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const first = validated.decisions[0]!;
    expect(first.verdict !== "ignore" && first.parts).toEqual([
      expect.objectContaining({ type: "Error", app: "pwa", priority: "Low", assignee: "person", difficulty: "easy", storyPoints: 2, duplicate: null, unverifiedDuplicate: null }),
      expect.objectContaining({ priority: "High", assignee: "person", difficulty: "hard", storyPoints: 5 }),
    ]);
    expect(validated.notes).toEqual([expect.stringContaining('report 1.000100: additional_issues[0] assignee "agent" changed to "person"')]);
    // A report with one problem carries no parts at all.
    expect(validated.decisions[1]).not.toHaveProperty("parts");
  });

  it("keeps a pwa part with its agent when a pwa agent project exists", () => {
    const validated = validatePlan({ batch: BATCH, entries: [issue("1.000100", { additional_issues: [part()] }), issue("2.000100")] }, BATCH, REPORTS, { pwaAgents: true, apps: APP_LABELS });
    expect(validated.ok && validated.decisions[0]!.verdict !== "ignore" && validated.decisions[0]!.parts![0]!.assignee).toBe("agent");
  });

  it("takes a candidate as a part's possible duplicate, and anything else as unverified", () => {
    const validated = validatePlan(
      { batch: BATCH, entries: [issue("1.000100", { additional_issues: [part({ duplicate_of: "OA-12" }), part({ duplicate_of: "OA-99" }), part({ duplicate_of: "2.000100" })] }), issue("2.000100")] },
      BATCH,
      REPORTS, { apps: APP_LABELS },
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok || validated.decisions[0]!.verdict === "ignore") return;
    expect(validated.decisions[0]!.parts!.map((one) => [one.duplicate?.key ?? null, one.unverifiedDuplicate])).toEqual([
      ["OA-12", null],
      [null, "OA-99"],
      [null, null],
    ]);
  });

  it("refuses parts on a decision, a part missing a field, and more than ten tickets in all", () => {
    const decision = { report: "1.000100", verdict: "decision", app: "pwa", difficulty: "easy", story_points: 1, summary_es: "x", description_es: "y", additional_issues: [part()] };
    const refused = (entry: Record<string, unknown>) => {
      const validated = validatePlan({ batch: BATCH, entries: [entry, issue("2.000100")] }, BATCH, REPORTS, { apps: APP_LABELS });
      return validated.ok ? [] : validated.problems;
    };
    expect(refused(decision)).toEqual([expect.stringContaining('additional_issues is only for an "issue"')]);
    expect(refused(issue("1.000100", { additional_issues: [part({ story_points: "2", summary_es: undefined })] }))).toEqual([
      expect.stringContaining("additional_issues[0].story_points must be one of 1, 2, 3, 5, 8"),
      expect.stringContaining("additional_issues[0].summary_es must be a one-line summary"),
    ]);
    expect(refused(issue("1.000100", { additional_issues: Array.from({ length: 10 }, () => part()) }))).toEqual([expect.stringContaining("at most 10 tickets")]);
    expect(refused(issue("1.000100", { additional_issues: "four" }))).toEqual([expect.stringContaining("must be an array")]);
    // Empty is one problem, not a mistake.
    expect(refused(issue("1.000100", { additional_issues: [] }))).toEqual([]);
  });
});

describe("a duplicate's assignee matches its original's", () => {
  const FOR_AGENT: Candidate = { ...OPEN, key: "OAI-30", labels: ["slack-intake", "para-agente"] };
  const FOR_PERSON: Candidate = { ...OPEN, key: "OAI-31", labels: ["slack-intake", "para-persona"] };
  const BOTH = [report("1.000100", [FOR_AGENT, FOR_PERSON, OPEN]), report("2.000100", [FOR_AGENT, FOR_PERSON, OPEN])];
  const validate = (entries: unknown[], options = {}) => validatePlan({ batch: BATCH, entries }, BATCH, BOTH, { apps: APP_LABELS, ...options });
  const assignees = (validated: ReturnType<typeof validate>) => (validated.ok ? validated.decisions.map((decision) => decision.verdict !== "ignore" && decision.assignee) : validated.problems);

  it("takes a candidate's para-* label over the session's, sure or unsure", () => {
    const validated = validate([
      issue("1.000100", { duplicate_of: "OAI-31", duplicate_confidence: "unsure" }),
      issue("2.000100", { assignee: "person", duplicate_of: "OAI-30", duplicate_confidence: "sure" }),
    ]);
    expect(assignees(validated)).toEqual(["person", "agent"]);
    expect(validated.ok && validated.notes).toEqual([
      'report 1.000100: assignee "agent" changed to "person" to match OAI-31, which it duplicates',
      'report 2.000100: assignee "person" changed to "agent" to match OAI-30, which it duplicates',
    ]);
  });

  it("leaves the session's when the original carries neither label, or already matches", () => {
    const validated = validate([
      issue("1.000100", { assignee: "person", duplicate_of: "OA-12", duplicate_confidence: "unsure" }),
      issue("2.000100", { duplicate_of: "OAI-30", duplicate_confidence: "unsure" }),
    ]);
    expect(assignees(validated)).toEqual(["person", "agent"]);
    expect(validated.ok && validated.notes).toEqual([]);
  });

  it("relabels the original a person's when the duplicate must be one: a decision, or a report forced to a person", () => {
    const validated = validate([
      { report: "1.000100", verdict: "decision", app: "none", difficulty: "easy", story_points: 1, summary_es: "x", description_es: "y", duplicate_of: "OAI-30", duplicate_confidence: "unsure" },
      issue("2.000100", { priority: "Highest", duplicate_of: "OAI-30", duplicate_confidence: "unsure" }),
    ]);
    expect(assignees(validated)).toEqual(["person", "person"]);
    expect(validated.ok && validated.decisions.map((decision) => decision.verdict !== "ignore" && decision.relabel)).toEqual([["OAI-30"], ["OAI-30"]]);
    expect(validated.ok && validated.notes).toEqual([
      // The rail's note is written as the entry is read; the match after every entry is.
      'report 2.000100: assignee "agent" changed to "person": Prioridad Highest: la revisa una persona.',
      'report 1.000100: OAI-30, which it duplicates, relabelled "para-persona" to match: it goes to a person: a decision is a person\'s',
      'report 2.000100: OAI-30, which it duplicates, relabelled "para-persona" to match: it goes to a person: Prioridad Highest: la revisa una persona.',
    ]);
  });

  it("relabels nothing when the original is a person's or carries neither label", () => {
    const validated = validate([
      issue("1.000100", { priority: "Highest", duplicate_of: "OAI-31", duplicate_confidence: "unsure" }),
      issue("2.000100", { priority: "Highest", duplicate_of: "OA-12", duplicate_confidence: "unsure" }),
    ]);
    expect(validated.ok && validated.decisions.map((decision) => decision.verdict !== "ignore" && decision.relabel)).toEqual([undefined, undefined]);
  });

  it("relabels the original of a part that must be a person's", () => {
    const part = { type: "Error", app: "pwa", priority: "Low", assignee: "agent", difficulty: "easy", story_points: 2, summary_es: "x", description_es: "y", duplicate_of: "OAI-30" };
    const validated = validate([issue("1.000100", { additional_issues: [part] }), issue("2.000100")]);
    expect(validated.ok && validated.decisions[0]!.verdict !== "ignore" && [validated.decisions[0]!.parts![0]!.assignee, validated.decisions[0]!.relabel]).toEqual(["person", ["OAI-30"]]);
    expect(validated.ok && validated.notes).toEqual([
      expect.stringContaining('additional_issues[0] assignee "agent" changed to "person"'),
      'report 1.000100: OAI-30, which additional_issues[0] duplicates, relabelled "para-persona" to match: No hay un proyecto de agentes para acme-pwa.',
    ]);
  });

  it("sends a whole batch chain and its original to a person when one report of it must go to one", () => {
    const THREE = [report("1.000100", [FOR_AGENT]), report("2.000100"), report("3.000100")];
    const validated = validatePlan(
      {
        batch: "batch-3",
        entries: [
          issue("1.000100", { duplicate_of: "OAI-30", duplicate_confidence: "unsure" }),
          issue("2.000100", { duplicate_of: "1.000100", duplicate_confidence: "unsure" }),
          issue("3.000100", { priority: "Highest", duplicate_of: "2.000100", duplicate_confidence: "unsure" }),
        ],
      },
      "batch-3",
      THREE, { apps: APP_LABELS },
    );
    expect(assignees(validated)).toEqual(["person", "person", "person"]);
    expect(validated.ok && validated.decisions[0]!.verdict !== "ignore" && validated.decisions[0]!.relabel).toEqual(["OAI-30"]);
    expect(validated.ok && validated.notes).toEqual([
      'report 3.000100: assignee "agent" changed to "person": Prioridad Highest: la revisa una persona.',
      'report 1.000100: assignee "agent" changed to "person" to match report 3.000100, a report of the same problem that goes to a person: Prioridad Highest: la revisa una persona.',
      'report 2.000100: assignee "agent" changed to "person" to match report 3.000100, a report of the same problem that goes to a person: Prioridad Highest: la revisa una persona.',
      'report 1.000100: OAI-30, which it duplicates, relabelled "para-persona" to match: report 3.000100 goes to a person: Prioridad Highest: la revisa una persona.',
    ]);
  });

  it("matches a part to the candidate it names", () => {
    const part = { type: "Error", app: "Backoffice", priority: "Low", assignee: "agent", difficulty: "easy", story_points: 2, summary_es: "x", description_es: "y", duplicate_of: "OAI-31" };
    const validated = validate([issue("1.000100", { additional_issues: [part] }), issue("2.000100")]);
    expect(validated.ok && validated.decisions[0]!.verdict !== "ignore" && validated.decisions[0]!.parts![0]!.assignee).toBe("person");
    expect(validated.ok && validated.notes).toEqual(['report 1.000100: additional_issues[0] assignee "agent" changed to "person" to match OAI-31, which it duplicates']);
  });

  it("matches a duplicate of an earlier report to the root of its chain", () => {
    const THREE = [report("1.000100", [FOR_PERSON]), report("2.000100"), report("3.000100")];
    const validated = validatePlan(
      {
        batch: "batch-3",
        entries: [
          // The root takes OAI-31's person first; the chain follows the root.
          issue("1.000100", { duplicate_of: "OAI-31", duplicate_confidence: "unsure" }),
          issue("2.000100", { duplicate_of: "1.000100", duplicate_confidence: "unsure" }),
          issue("3.000100", { duplicate_of: "2.000100", duplicate_confidence: "sure" }),
        ],
      },
      "batch-3",
      THREE,
      { apps: APP_LABELS },
    );
    expect(assignees(validated)).toEqual(["person", "person", "person"]);
    expect(validated.ok && validated.notes).toEqual([
      'report 1.000100: assignee "agent" changed to "person" to match OAI-31, which it duplicates',
      'report 2.000100: assignee "agent" changed to "person" to match report 1.000100, which it duplicates',
      'report 3.000100: assignee "agent" changed to "person" to match report 1.000100, which it duplicates',
    ]);
  });
});
