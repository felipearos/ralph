import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { asPending, FINDING_LABEL, findingBody, findingMarker, pendingFinding, promoteFinding, registryArgs, registryRows, type FindingGh } from "./findings";
import { parseLearnings } from "./learnings";
import { isRoutingExempt, routeByDifficulty } from "./jav";
import { fileScratchDir } from "./test-scratch";

// The setup's record is one per file; a ticket one test files must not make
// the next test's finding look filed already.
const records = fileScratchDir("ralph-findings-record-");
let recordCount = 0;
const freshRecord = (): string => join(records, `${(recordCount += 1)}`, "findings.json");
beforeEach(() => { process.env.RALPH_FINDINGS_RECORD = freshRecord(); });

const target = { repo: "owner/project", file: "learnings/project.md", sourceRepo: "owner/harness" };
const block = (extra = "") => `### Missing fixture (2026-10-13)
<!-- learning: missing-fixture -->
- **Seen:** build 31 fails on missing genres.json.
- **Workaround:** use the hermetic stub.
${extra}
- **Fix:** no issue yet.
`;
const entry = (text = block()) => parseLearnings(`## Open\n\n${text}`).open[0]!;

function github(rows: unknown[] = []) {
  const calls: string[][] = [];
  let body = "";
  const gh: FindingGh = (args) => {
    calls.push(args);
    // Shaped like `gh api --paginate --slurp`: one array of raw issue pages.
    if (args[0] === "api") return JSON.stringify([(rows as { url: string }[]).map(({ url, ...row }) => ({ ...row, html_url: url }))]);
    if (args[0] === "issue" && args[1] === "create") {
      body = readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8");
      rows.push({ number: 42, body, url: "https://github.com/owner/project/issues/42" });
      return "https://github.com/owner/project/issues/42\n";
    }
    return "";
  };
  return { gh, calls, body: () => body };
}

describe("findings become fix tickets", () => {
  it("files an evidenced actionable finding ready for a coder and links it back", () => {
    const io = github();
    const draft = entry(block("- **Change:** add genres.json to the stub.\n- **Verify:** the genre discovery regression test passes."));
    const linked = promoteFinding(draft, target, io.gh);
    expect(linked).toContain("- **Fix:** https://github.com/owner/project/issues/42");
    expect(io.calls.find((args) => args[1] === "create" && args[0] === "issue")).toEqual(expect.arrayContaining(["ready-for-agent", FINDING_LABEL]));
    expect(io.body()).toContain("add genres.json");
    expect(io.body()).toContain("genre discovery regression test passes");
    expect(io.body()).toContain("https://github.com/owner/harness/blob/main/learnings/project.md");
    expect(io.body()).not.toContain("_Posted by");
  });

  it("leaves unspecific findings to triage without guessing a fix", () => {
    const io = github();
    promoteFinding(entry(), target, io.gh);
    expect(io.calls.find((args) => args[0] === "issue" && args[1] === "create")).toContain("needs-triage");
    expect(findingBody(entry(), target).ready).toBe(false);
  });

  it("reuses the ticket on a retry even when the previous link never published", () => {
    const io = github();
    const original = entry();
    const first = promoteFinding(original, target, io.gh);
    const again = promoteFinding(original, target, io.gh);
    expect(first).toBe(again);
    expect(io.calls.filter((args) => args[0] === "issue" && args[1] === "create")).toHaveLength(1);
    expect(promoteFinding(entry(first), target, () => { throw new Error("should not read GitHub"); })).toBe(first);
  });

  it("reuses a closed ticket instead of filing a duplicate or claiming a fix merged", () => {
    const io = github([{ number: 42, body: findingMarker(target, "missing-fixture"), state: "CLOSED", url: "https://github.com/owner/project/issues/42" }]);
    expect(promoteFinding(entry(), target, io.gh)).toContain("issues/42");
    expect(io.calls).toHaveLength(1);
  });

  it("refuses an unreadable, malformed, duplicated or truncated registry before creating", () => {
    expect(() => promoteFinding(entry(), target, () => { throw new Error("rate limited"); })).toThrow("rate limited");
    for (const value of [{}, [{}], Array.from({ length: 1000 }, () => ({}))]) {
      expect(() => promoteFinding(entry(), target, () => JSON.stringify(value))).toThrow();
    }
    const row = { number: 42, body: findingMarker(target, "missing-fixture"), url: "https://github.com/owner/project/issues/42" };
    expect(() => promoteFinding(entry(), target, github([row, row]).gh)).toThrow("multiple tickets");
  });

  it("does not treat quoted metadata as a field or rewrite a quoted Fix", () => {
    const quoted = entry(block("```md\n- **Change:** unsafe quoted change\n- **Verify:** unsafe quoted verification\n- **Fix:** no issue yet.\n```"));
    expect(findingBody(quoted, target).ready).toBe(false);
    const linked = promoteFinding(quoted, target, github().gh);
    expect(linked).toContain("- **Fix:** no issue yet.\n```");
    expect(linked).toContain("- **Fix:** https://github.com/owner/project/issues/42");
    expect(pendingFinding(entry(block().replace("no issue yet.", "#123")))).toBe(false);
  });

  it("files a finding whose Fix explains itself after the placeholder, keeping the explanation", () => {
    const io = github();
    const reasoned = entry(block("- **Change:** read only the first line.\n- **Verify:** a footer after the section parses.")
      .replace("no issue yet.", "no issue yet. Make parseStaffingGroup read only the first non-empty line."));
    expect(pendingFinding(reasoned)).toBe(true);
    const linked = promoteFinding(reasoned, target, io.gh);
    expect(linked).toContain("- **Fix:** https://github.com/owner/project/issues/42 — Make parseStaffingGroup read only the first non-empty line.");
    expect(io.body()).toContain("## Suggested fix\n\nMake parseStaffingGroup read only the first non-empty line.");
    expect(io.calls.find((args) => args[0] === "issue" && args[1] === "create")).toContain("ready-for-agent");
    // Linked once, it is settled: a second promote reads nothing and files nothing.
    expect(pendingFinding(entry(linked))).toBe(false);
  });

  it("reads the placeholder however the loop punctuated it, and nothing that only mentions it", () => {
    for (const fix of ["no issue yet", "No issue yet.", "no issue yet — an operator must act", "no issue yet (the agent needs a restart policy)"]) {
      expect(pendingFinding(entry(block().replace("no issue yet.", fix)))).toBe(true);
    }
    for (const fix of ["operator side, no issue yet. Apply it by hand.", "#716 refreshed it: no issue yet.", "no issue yetis not a word"]) {
      expect(pendingFinding(entry(block().replace("no issue yet.", fix)))).toBe(false);
    }
  });

  it("sends an operator-side fix to triage even when Change and Verify are written", () => {
    const io = github();
    const operator = entry(block("- **Change:** restart the agent.\n- **Verify:** builds start.")
      .replace("no issue yet.", "no issue yet. An operator restores the account's access."));
    promoteFinding(operator, target, io.gh);
    expect(io.calls.find((args) => args[0] === "issue" && args[1] === "create")).toContain("needs-triage");
  });

  it("makes an untriaged fix available without overriding an explicit difficulty", () => {
    expect(isRoutingExempt(new Set([FINDING_LABEL]))).toBe(true);
    const tickets = [{ labels: new Set([FINDING_LABEL]) }, { labels: new Set([FINDING_LABEL, "difficulty:hard"]) }];
    expect(routeByDifficulty(tickets, ["difficulty:easy"], ["difficulty:easy", "difficulty:hard"])).toEqual([tickets[0]]);
  });
});

describe("the host findings record", () => {
  const url = "https://github.com/owner/project/issues/42";
  const marker = findingMarker(target, "missing-fixture");
  const creates = (calls: string[][]) => calls.filter((args) => args[0] === "issue" && args[1] === "create");
  // A registry read that never shows a ticket created seconds ago (#481/#482).
  function lagging() {
    const calls: string[][] = [];
    let n = 41;
    const gh: FindingGh = (args) => {
      calls.push(args);
      if (args[0] === "api") return JSON.stringify([[]]);
      if (args[0] === "issue" && args[1] === "create") return `https://github.com/owner/project/issues/${(n += 1)}\n`;
      return "";
    };
    return { gh, calls };
  }
  const recordAt = (value: unknown): string => {
    const path = freshRecord();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };

  it("files once when the registry read misses the ticket it just created", () => {
    const io = lagging();
    const original = entry();
    const record = freshRecord();
    const first = promoteFinding(original, target, io.gh, record);
    const again = promoteFinding(original, target, io.gh, record);
    expect(creates(io.calls)).toHaveLength(1);
    expect(first).toContain(`- **Fix:** ${url}`);
    expect(again).toContain(`- **Fix:** ${url}`);
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ [marker]: url });
  });

  it("is per host: two separate records file twice against the same lagging registry", () => {
    const io = lagging();
    promoteFinding(entry(), target, io.gh, freshRecord());
    promoteFinding(entry(), target, io.gh, freshRecord());
    expect(creates(io.calls)).toHaveLength(2);
  });

  it("links a recorded ticket, a registry ticket, and refuses two different ones", () => {
    const recordOnly = lagging();
    expect(promoteFinding(entry(), target, recordOnly.gh, recordAt({ [marker]: "https://github.com/owner/project/issues/7" }))).toContain("- **Fix:** https://github.com/owner/project/issues/7");
    expect(creates(recordOnly.calls)).toHaveLength(0);
    const registryOnly = github([{ number: 8, body: marker, url: "https://github.com/owner/project/issues/8" }]);
    expect(promoteFinding(entry(), target, registryOnly.gh, freshRecord())).toContain("- **Fix:** https://github.com/owner/project/issues/8");
    expect(creates(registryOnly.calls)).toHaveLength(0);
    const both = github([{ number: 8, body: marker, url: "https://github.com/owner/project/issues/8" }]);
    expect(() => promoteFinding(entry(), target, both.gh, recordAt({ [marker]: "https://github.com/owner/project/issues/7" }))).toThrow("multiple tickets for finding missing-fixture; needs triage");
    expect(creates(both.calls)).toHaveLength(0);
  });

  it("reads a missing record as empty and refuses one it cannot read before creating", () => {
    const io = lagging();
    expect(promoteFinding(entry(), target, io.gh, join(freshRecord(), "absent.json"))).toContain(`- **Fix:** ${url}`);
    expect(creates(io.calls)).toHaveLength(1);
    const directory = freshRecord();
    mkdirSync(directory, { recursive: true });
    for (const path of [recordAt("{not json"), recordAt([]), recordAt({ [marker]: 42 }), directory]) {
      const bad = lagging();
      expect(() => promoteFinding(entry(), target, bad.gh, path)).toThrow(`findings record ${path} unreadable; no issue created`);
      expect(creates(bad.calls)).toHaveLength(0);
    }
  });
});

describe("findings registry read", () => {
  it("never combines --slurp with --jq or --template, which gh rejects", () => {
    const io = github();
    promoteFinding(entry(), target, io.gh);
    const read = io.calls.find((args) => args[0] === "api");
    expect(read).toEqual(["api", `repos/owner/project/issues?state=all&labels=${FINDING_LABEL}&per_page=100`, "--paginate", "--slurp"]);
    expect(registryArgs("owner/project")).toEqual(read);
  });

  it("flattens every slurped page into rows", () => {
    const pages = [
      [{ number: 1, body: "a", html_url: "https://github.com/o/p/issues/1", title: "x" }, { number: 2, body: null, html_url: "https://github.com/o/p/issues/2" }],
      [{ number: 3, body: "c", html_url: "https://github.com/o/p/issues/3" }],
    ];
    expect(registryRows(JSON.stringify(pages))).toEqual([
      { number: 1, body: "a", url: "https://github.com/o/p/issues/1" },
      { number: 2, body: "", url: "https://github.com/o/p/issues/2" },
      { number: 3, body: "c", url: "https://github.com/o/p/issues/3" },
    ]);
    expect(() => registryRows(JSON.stringify([{ number: 1 }]))).toThrow("registry unreadable");
  });

  it("reuses a ticket that sits on a later page", () => {
    const marker = findingMarker(target, "missing-fixture");
    const first = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, body: "other", html_url: `https://github.com/owner/project/issues/${i + 1}` }));
    const calls: string[][] = [];
    const gh: FindingGh = (args) => {
      calls.push(args);
      return args[0] === "api" ? JSON.stringify([first, [{ number: 101, body: marker, html_url: "https://github.com/owner/project/issues/101" }]]) : "";
    };
    expect(promoteFinding(entry(), target, gh)).toContain("issues/101");
    expect(calls).toHaveLength(1);
  });
});

describe("filing one entry at an operator's request", () => {
  const withFix = (fix: string | null) =>
    entry(`### Missing fixture (2026-10-13)
<!-- learning: missing-fixture -->
- **Seen:** build 31 fails on missing genres.json.
- **Workaround:** use the hermetic stub.
${fix === null ? "" : `- **Fix:** ${fix}`}
`);

  it("turns an operator's Fix into the placeholder, keeping its words, so the ticket goes to triage", () => {
    const draft = asPending(withFix("operator side. Apply it by hand."));
    expect(draft).toContain("- **Fix:** no issue yet — operator side. Apply it by hand.");
    const pending = entry(draft);
    expect(pendingFinding(pending)).toBe(true);
    expect(findingBody(pending, target).ready).toBe(false);
  });

  it("adds the placeholder to an entry without a Fix, and leaves a queued one as it is", () => {
    expect(asPending(withFix(null))).toMatch(/- \*\*Fix:\*\* no issue yet\.$/);
    expect(asPending(entry())).toBe(entry().text);
  });

  it("refuses an entry that already names a ticket or another entry, or lacks its evidence", () => {
    expect(() => asPending(withFix("https://github.com/owner/project/issues/42"))).toThrow(/already reads/);
    expect(() => asPending(withFix("#168 includes a live test."))).toThrow(/already reads/);
    expect(() => asPending(withFix("duplicate; close with `other`."))).toThrow(/already reads/);
    expect(() => asPending(entry("### Thin (2026-10-13)\n<!-- learning: thin -->\n- **Seen:** once.\n"))).toThrow(/Seen and Workaround/);
  });

  it("rewrites the real Fix line, never a fenced example of one", () => {
    const fenced = entry(`### Fenced (2026-10-13)
<!-- learning: fenced -->
- **Seen:** once.
- **Workaround:** the stub.
\`\`\`
- **Fix:** example inside a fence
\`\`\`
- **Fix:** strip ANSI in the parser.
`);
    const draft = asPending(fenced);
    expect(draft).toContain("- **Fix:** example inside a fence");
    expect(draft).toContain("- **Fix:** no issue yet — strip ANSI in the parser.");
  });
});
