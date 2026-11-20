import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  routableLoops,
  DEFAULT_JAV,
  javLabelsFor,
  javPath,
  javReport,
  migrateJav,
  readJav,
  reservedLabels,
  reservedWhy,
  routeByDifficulty,
  isRoutingExempt,
  ROUTING_EXEMPT_LABELS,
  rosterNames,
  saveJav,
  validateJav,
} from "./jav";
import { CASE_LABEL, CODER_FILING_LABELS } from "./ci-doctor/case-issue";
import { URGENT_LABEL } from "./frontier/next-tasks";
import type { RosterEntry } from "./project-config";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs the jav CLI through bash and bun");

const ROSTER = ["ralph", "rafa", "remo", "rulo"] as const;

const routed = {
  enabled: true,
  labels: ["difficulty:easy", "difficulty:hard"],
  routes: {
    ralph: ["difficulty:hard"],
    rafa: ["difficulty:hard"],
    remo: ["difficulty:easy"],
    rulo: ["difficulty:easy"],
  },
};

describe("validateJav", () => {
  it("accepts a complete routing", () => {
    expect(validateJav(routed, ROSTER)).toEqual({ config: routed, problems: [] });
  });

  it("accepts Jav off with nothing configured", () => {
    expect(validateJav(DEFAULT_JAV, ROSTER).config).toEqual(DEFAULT_JAV);
  });

  it("keeps a switched-off routing so turning it back on restores it", () => {
    const off = { ...routed, enabled: false, routes: { ralph: ["difficulty:hard"] } };
    // Off does not demand every label be routed: it routes nothing.
    expect(validateJav(off, ROSTER).config).toEqual(off);
  });

  it("refuses unknown keys, unknown loops and unlisted labels, all at once", () => {
    const { config, problems } = validateJav(
      { ...routed, colour: "red", routes: { ...routed.routes, zed: [], remo: ["difficulty:medium"] } },
      ROSTER,
    );
    expect(config).toBeNull();
    expect(problems).toEqual(
      expect.arrayContaining([
        "unknown key 'colour'",
        expect.stringContaining("'zed' is not a loop"),
        "routes.remo names 'difficulty:medium', which is not in 'labels'",
      ]),
    );
  });

  it("refuses a label no loop takes when Jav is on", () => {
    const { problems } = validateJav({ ...routed, routes: { ralph: ["difficulty:hard"] } }, ROSTER);
    expect(problems).toEqual(["no loop takes 'difficulty:easy', so its tickets would never be picked"]);
  });

  it("refuses Jav on with no labels", () => {
    expect(validateJav({ enabled: true, labels: [], routes: {} }, ROSTER).problems).toEqual([
      "Jav is on but no labels are configured",
    ]);
  });

  it("refuses labels the loop already means something by, and duplicates", () => {
    const { problems } = validateJav(
      { enabled: false, labels: ["ready-for-agent", "rafa-wip", "x", "x", " y"], routes: {} },
      ROSTER,
    );
    expect(problems).toEqual([
      "'ready-for-agent' is a label the loop already uses; pick a difficulty label",
      "'rafa-wip' is a label the loop already uses; pick a difficulty label",
      "label 'x' is listed twice",
      "label ' y' has leading or trailing spaces",
    ]);
  });
});

/**
 * A roster that mixes roles. Routes and the stranded-label check are about the
 * coders; reservation is about every name. Pinned here rather than in
 * `role-fences.test.ts` because these are Jav's own judgements, asked of a
 * roster passed in.
 */
describe("a roster that mixes roles", () => {
  const MIXED = [
    { name: "ralph", role: "coder" },
    { name: "tria", role: "triager" },
    { name: "rafa", role: "coder" },
    { name: "doc", role: "ci-doctor" },
  ] as const satisfies readonly RosterEntry[];

  const mixedRouted = { enabled: true, labels: ["difficulty:easy", "difficulty:hard"], routes: { ralph: ["difficulty:hard"], rafa: ["difficulty:easy"] } };

  it("reads names and coders out of either roster form", () => {
    expect(rosterNames(MIXED)).toEqual(["ralph", "tria", "rafa", "doc"]);
    expect(routableLoops(MIXED)).toEqual(["ralph", "rafa"]);
    expect(rosterNames(ROSTER)).toEqual([...ROSTER]);
    expect(routableLoops(ROSTER)).toEqual([...ROSTER]);
  });

  it("refuses a route to a triager or a ci-doctor, naming its role", () => {
    const { config, problems } = validateJav(
      { ...mixedRouted, routes: { ...mixedRouted.routes, tria: ["difficulty:easy"], doc: ["difficulty:hard"] } },
      MIXED,
    );
    expect(config).toBeNull();
    expect(problems).toEqual([
      "'tria' is a triager, which never takes frontier work; route targets are ralph, rafa, or default",
      "'doc' is a ci-doctor, which never takes frontier work; route targets are ralph, rafa, or default",
    ]);
  });

  it("still refuses a name on no roster, and offers only the coders", () => {
    const { problems } = validateJav({ ...mixedRouted, routes: { ...mixedRouted.routes, zed: [] } }, MIXED);
    expect(problems).toEqual(["'zed' is not a loop (ralph, rafa, or default)"]);
  });

  it("reserves every roster name's claim labels, whatever its role", () => {
    const reserved = reservedLabels(MIXED);
    for (const loop of ["ralph", "tria", "rafa", "doc"]) {
      expect(reserved).toEqual(expect.arrayContaining([`${loop}-wip`, `${loop}-blocked`, `${loop}-done`]));
    }
    expect(validateJav({ enabled: false, labels: ["tria-wip"], routes: {} }, MIXED).problems).toEqual([
      "'tria-wip' is a label the loop already uses; pick a difficulty label",
    ]);
  });

  it("reserves every label a ci-doctor filing carries, so no project can route the exemption off", () => {
    // Routing on ANY of them puts a configured label on every filing, so
    // `routeByDifficulty` stops reading one as stranded and the exemption never
    // fires again — silently (felipearos/ralph#233). `bug` is the one that is
    // neither exempt nor a claim marker, and it is the plausible one to route on.
    const filing = [...new Set([...CODER_FILING_LABELS, ...ROUTING_EXEMPT_LABELS])];
    expect(filing).toContain("bug");
    for (const label of filing) {
      expect(reservedLabels(MIXED)).toContain(label);
      const { problems } = validateJav({ enabled: false, labels: [label], routes: {} }, MIXED);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`'${label}'`);
    }
    // And the refusal says WHICH reason applies, since the operator reads it on
    // the Routing page and the two reasons want different answers.
    expect(reservedWhy("bug")).toContain("switch off the urgent lane's exemption");
    expect(reservedWhy("ralph-wip")).toContain("pick a difficulty label");
    expect(reservedWhy("ready-for-agent")).toContain("pick a difficulty label");
  });

  it("strands a label only `default` takes when no coder falls back to it", () => {
    // Both coders have a route of their own, so `default` is reached by `tria`
    // and `doc` alone — and neither ever picks a frontier ticket.
    const onlyDefault = { ...mixedRouted, routes: { ralph: ["difficulty:hard"], rafa: ["difficulty:hard"], default: ["difficulty:easy"] } };
    expect(validateJav(onlyDefault, MIXED).problems).toEqual([
      "no loop takes 'difficulty:easy', so its tickets would never be picked",
    ]);
    // The same block where a coder DOES fall back to `default` is fine.
    const { default: fallback, ...ownRoutes } = onlyDefault.routes;
    expect(validateJav({ ...onlyDefault, routes: { ralph: ownRoutes.ralph, default: fallback } }, MIXED).problems).toEqual([]);
  });

  it("throws rather than routing when the file on disk already routes a non-coder", () => {
    // The upgrade path: a `jav.json` written before roles may carry `routes.tria`.
    // `readJav` refuses it like any invalid block — routing every ticket to every
    // loop is what Jav exists to prevent — so the key must be removed by hand.
    const dir = mkdtempSync(join(tmpdir(), "jav-mixed-"));
    try {
      const path = join(dir, "jav.json");
      writeFileSync(
        path,
        `${JSON.stringify({ loggd: { ...mixedRouted, routes: { ...mixedRouted.routes, tria: ["difficulty:easy"] } } })}\n`,
      );
      expect(() => readJav(path, "loggd", MIXED)).toThrow(/'tria' is a triager, which never takes frontier work/);
      // The same file read with a bare-name roster is the pre-roles judgement.
      expect(readJav(path, "loggd", ["ralph", "tria", "rafa", "doc"]).routes.tria).toEqual(["difficulty:easy"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a routing that covers every coder, and round-trips it", () => {
    const dir = mkdtempSync(join(tmpdir(), "jav-mixed-"));
    try {
      const path = join(dir, "jav.json");
      expect(validateJav(mixedRouted, MIXED)).toEqual({ config: mixedRouted, problems: [] });
      expect(saveJav(path, "loggd", mixedRouted, MIXED)).toEqual({ config: mixedRouted, problems: [] });
      expect(readJav(path, "loggd", MIXED)).toEqual(mixedRouted);
      expect(javReport(path, "loggd", MIXED)).toMatchObject({
        own: true,
        loops: ["ralph", "rafa"],
        reserved: expect.arrayContaining(["tria-wip", "doc-done", "ralph-wip"]),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("routing", () => {
  const ticket = (number: number, ...labels: string[]) => ({ number, labels: new Set(labels) });
  const tickets = [
    ticket(1, "ready-for-agent", "difficulty:hard"),
    ticket(2, "ready-for-agent", "difficulty:easy"),
    ticket(3, "ready-for-agent"),
  ];

  it("leaves every ticket to every loop when Jav is off", () => {
    const route = javLabelsFor({ ...routed, enabled: false }, "remo");
    expect(route).toBeNull();
    expect(routeByDifficulty(tickets, route, routed.labels).map((t) => t.number)).toEqual([1, 2, 3]);
  });

  it("gives a loop only the tickets labelled for it, and nobody the untriaged ones", () => {
    expect(routeByDifficulty(tickets, javLabelsFor(routed, "ralph"), routed.labels).map((t) => t.number)).toEqual([
      1,
    ]);
    expect(routeByDifficulty(tickets, javLabelsFor(routed, "remo"), routed.labels).map((t) => t.number)).toEqual([
      2,
    ]);
  });

  it("gives a loop with no route nothing", () => {
    const route = javLabelsFor({ ...routed, routes: { ralph: routed.labels } }, "rulo");
    expect(route).toEqual([]);
    expect(routeByDifficulty(tickets, route, routed.labels)).toEqual([]);
  });

  it("gives a loop without a route of its own the project's default route", () => {
    const config = { ...routed, routes: { ralph: ["difficulty:hard"], default: ["difficulty:easy"] } };
    expect(validateJav(config, ROSTER).problems).toEqual([]);
    expect(javLabelsFor(config, "ralph")).toEqual(["difficulty:hard"]);
    expect(javLabelsFor(config, "rulo")).toEqual(["difficulty:easy"]);
  });

  it("lets one loop take several labels", () => {
    const route = javLabelsFor({ ...routed, routes: { ralph: routed.labels } }, "ralph");
    expect(routeByDifficulty(tickets, route, routed.labels).map((t) => t.number)).toEqual([1, 2]);
  });

  // felipearos/ralph#233. The ci-doctor's filings carry no difficulty label and
  // cannot: the doctor has no way to know whether a regression is easy work.
  // Routing used to drop them, so the one lane that exists to put a red base
  // branch in front of the queue was the lane nobody was offered.
  describe("the ci-doctor's filings are exempt", () => {
    const urgent = ticket(4, "ready-for-agent", "bug", "ci-health", "priority:urgent");
    // What `fileForCoders` applies without the urgent write on top: the
    // out-of-scope filing, the forward fix and the `fix-failed` hand-off.
    const filing = ticket(5, "ready-for-agent", "bug", "ci-health");
    const all = [...tickets, urgent, filing];

    it("keeps an urgent filing for a routed loop, ahead of nothing it carries", () => {
      expect(routeByDifficulty(all, javLabelsFor(routed, "ralph"), routed.labels).map((t) => t.number)).toEqual([
        1, 4, 5,
      ]);
      expect(routeByDifficulty(all, javLabelsFor(routed, "remo"), routed.labels).map((t) => t.number)).toEqual([
        2, 4, 5,
      ]);
    });

    it("keeps a ci-health filing that is not urgent, which is what covers the forward fix", () => {
      expect(isRoutingExempt(filing.labels)).toBe(true);
      expect(routeByDifficulty([filing], ["difficulty:hard"], routed.labels).map((t) => t.number)).toEqual([5]);
    });

    it("rescues only what routing would strand: a TRIAGED urgent ticket is still filtered", () => {
      // The cost #233 weighed and accepted: urgency must not hand hard work to
      // a loop routed away from it. A triager has judged this one easy, so an
      // easy loop takes it and the lane puts it first there — nothing is lost.
      const triaged = ticket(6, "ready-for-agent", "ci-health", "priority:urgent", "difficulty:easy");
      expect(routeByDifficulty([triaged], ["difficulty:hard"], routed.labels)).toEqual([]);
      expect(routeByDifficulty([triaged], ["difficulty:easy"], routed.labels).map((t) => t.number)).toEqual([6]);
    });

    it("is not a general fallback: a plain unlabelled ticket is still dropped", () => {
      expect(isRoutingExempt(tickets[2]!.labels)).toBe(false);
      expect(routeByDifficulty(all, ["difficulty:hard"], routed.labels).map((t) => t.number)).toEqual([1, 4, 5]);
    });

    it("changes nothing with Jav off, and gives a loop with no route nothing still", () => {
      expect(routeByDifficulty(all, null, routed.labels).map((t) => t.number)).toEqual([1, 2, 3, 4, 5]);
      // An empty route is a loop held out of the rotation, not a narrow one.
      expect(routeByDifficulty(all, [], routed.labels)).toEqual([]);
    });

    it("names exactly the labels their owners name", () => {
      // Literals in `jav.ts` because both owning modules import it; this is what
      // keeps them honest.
      expect(ROUTING_EXEMPT_LABELS).toEqual([URGENT_LABEL, CASE_LABEL, "learning-fix"]);
      // And the exemption reaches every coder-facing filing, not just the urgent
      // one: drop `ci-health` from the filing labels and this fails.
      expect(isRoutingExempt(new Set(CODER_FILING_LABELS))).toBe(true);
    });
  });
});

describe("the file", () => {
  let dir: string;
  const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), "jav-")));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

  it("is off when absent, or when neither the project nor default has a block", () => {
    const path = join(fresh(), "jav.json");
    expect(readJav(path, "loggd", ROSTER)).toEqual(DEFAULT_JAV);
    expect(javReport(path, "loggd", ROSTER)).toMatchObject({ exists: false, own: false, config: DEFAULT_JAV, problems: [] });
    write(path, { other: routed });
    expect(readJav(path, "loggd", ROSTER)).toEqual(DEFAULT_JAV);
  });

  it("routes each project by its own block, falling back to the default block", () => {
    const path = join(fresh(), "jav.json");
    const other = { enabled: true, labels: ["size:s"], routes: { ralph: ["size:s"] } };
    write(path, { loggd: routed, other, default: { ...routed, routes: { default: routed.labels } } });
    expect(javLabelsFor(readJav(path, "loggd", ROSTER), "ralph")).toEqual(["difficulty:hard"]);
    expect(javLabelsFor(readJav(path, "other", ["ralph"]), "ralph")).toEqual(["size:s"]);
    expect(javLabelsFor(readJav(path, "third", ["ralph"]), "ralph")).toEqual(routed.labels);
    expect(javReport(path, "third", ["ralph"])).toMatchObject({ own: false, project: "third" });
  });

  it("checks a project's block against that project's roster", () => {
    const path = join(fresh(), "jav.json");
    write(path, { other: { enabled: true, labels: ["x"], routes: { nova: ["x"] } } });
    expect(javLabelsFor(readJav(path, "other", ["nova"]), "nova")).toEqual(["x"]);
    expect(() => readJav(path, "other", ROSTER)).toThrow(/'nova' is not a loop/);
  });

  it("throws rather than routing to everyone when the file is broken", () => {
    const path = join(fresh(), "jav.json");
    writeFileSync(path, "{ not json");
    expect(() => readJav(path, "loggd", ROSTER)).toThrow(/not valid JSON/);
    write(path, { loggd: { ...routed, routes: {} } });
    expect(() => readJav(path, "loggd", ROSTER)).toThrow(/'loggd' is invalid: .*never be picked/);
    write(path, { "Not An Id": routed });
    expect(() => readJav(path, "loggd", ROSTER)).toThrow(/not a project id/);
  });

  it("reports an invalid block as written, with its problems, so the page can fix it", () => {
    const path = join(fresh(), "jav.json");
    const broken = { ...routed, routes: {} };
    write(path, { loggd: broken });
    const report = javReport(path, "loggd", ROSTER);
    expect(report.config).toEqual(broken);
    expect(report.own).toBe(true);
    expect(report.problems).toHaveLength(2);
    expect(report.reserved).toContain("ralph-wip");
  });

  it("saves one project's block and leaves every other block exactly as it was", () => {
    const path = join(fresh(), "jav.json");
    const other = { enabled: false, labels: ["size:s"], routes: {} };
    write(path, { other });
    expect(saveJav(path, "loggd", routed, ROSTER)).toEqual({ config: routed, problems: [] });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ other, loggd: routed });
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);

    const refused = saveJav(path, "loggd", { ...routed, routes: {} }, ROSTER);
    expect(refused.config).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ other, loggd: routed });
  });

  it("reads the unkeyed file as loggd's block, values unchanged, and never writes on a read", () => {
    const path = join(fresh(), "jav.json");
    write(path, routed);
    const before = readFileSync(path, "utf8");
    expect(migrateJav(routed)).toEqual({ loggd: routed });
    expect(readJav(path, "loggd", ROSTER)).toEqual(routed);
    expect(javReport(path, "loggd", ROSTER)).toMatchObject({ own: true, config: routed });
    expect(readJav(path, "other", ["nova"])).toEqual(DEFAULT_JAV);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("writes the migrated shape on the first save, and a keyed file never migrates again", () => {
    const path = join(fresh(), "jav.json");
    write(path, routed);
    const other = { enabled: false, labels: [], routes: {} };
    saveJav(path, "other", other, ["nova"]);
    const saved = readFileSync(path, "utf8");
    expect(JSON.parse(saved)).toEqual({ loggd: routed, other });
    expect(migrateJav(JSON.parse(saved))).toBeNull();
    expect(readJav(path, "loggd", ROSTER)).toEqual(routed);
    expect(readFileSync(path, "utf8")).toBe(saved);
  });

  it("refuses an unkeyed block beside a loggd one rather than guessing", () => {
    const path = join(fresh(), "jav.json");
    write(path, { ...routed, loggd: routed });
    expect(migrateJav({ ...routed, loggd: routed })).toBeNull();
    expect(() => readJav(path, "loggd", ROSTER)).toThrow(/'enabled' is not keyed by project/);
  });

  it("is found through RALPH_JAV, else RALPH_HOME", () => {
    expect(javPath({ RALPH_JAV: "/x/j.json", RALPH_HOME: "/h" })).toBe("/x/j.json");
    expect(javPath({ RALPH_HOME: "/h" })).toBe("/h/jav.json");
  });
});

describe("the CLI", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const bun = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();

  it("reads and saves only the project it is run for, against that project's roster", () => {
    dir = mkdtempSync(join(tmpdir(), "jav-cli-"));
    const root = join(dir, "other");
    mkdirSync(join(root, ".ralph"), { recursive: true });
    writeFileSync(
      join(root, ".ralph", "config.json"),
      JSON.stringify({
        repo: "o/other", owner: "o", baseBranch: "main", displayName: "Other",
        secrets: { runner: "none", withhold: [] }, refuseFiles: [], envCheck: [], requiredChecks: [], gates: {},
        promptFragment: ".ralph/prompt.md", coderFragment: ".ralph/coder.md", plan: ".ralph/plan.md",
        journal: { dir: "journal" }, loops: ["nova"],
      }),
    );
    const path = join(dir, "jav.json");
    writeFileSync(path, JSON.stringify({ loggd: routed }));
    const env = { ...process.env, RALPH_PROJECT: root, RALPH_JAV: path };
    const cli = (flag: string, input?: string) =>
      spawnSync(bun, [join(__dirname, "jav.ts"), flag], { encoding: "utf8", env, ...(input === undefined ? {} : { input }) });

    expect(JSON.parse(cli("--json").stdout)).toMatchObject({ project: "other", own: false, loops: ["nova"], config: DEFAULT_JAV });

    const block = { enabled: true, labels: ["x"], routes: { nova: ["x"] } };
    expect(JSON.parse(cli("--save", JSON.stringify(block)).stdout)).toEqual({ valid: true, problems: [] });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ loggd: routed, other: block });

    const refused = JSON.parse(cli("--save", JSON.stringify({ ...block, routes: { ralph: ["x"] } })).stdout);
    expect(refused.valid).toBe(false);
    expect(refused.problems).toContain("'ralph' is not a loop (nova, or default)");
  });
});
