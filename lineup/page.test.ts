// @vitest-environment node
/**
 * The static page, pinned statically: plain assets with no build step, and no
 * knowledge of the runtime below the HTTP view model.
 *
 * The runner options, the alias set and the model-id rules must reach the page
 * through the read response's schema. A hardcoded list is how the form and the
 * validator come to disagree, so the page's sources may not spell a harness
 * the loop can run on only one stage, an alias, or a CLI detail.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const STATIC = join(__dirname, "static");
const page = readFileSync(join(STATIC, "index.html"), "utf8");
const view = readFileSync(join(STATIC, "lineup-view.js"), "utf8");

describe("the page is plain static assets", () => {
  it("loads its helpers as a native module, with no bundler or remote script", () => {
    expect(page).toMatch(/<script type="module">/);
    expect(page).toContain('from "./lineup-view.js"');
    expect(page).not.toMatch(/<script[^>]+src=["']https?:/);
    expect(page).not.toMatch(/\.tsx?["']/);
    // The helpers import nothing at all: no module graph to build.
    expect(view).not.toMatch(/^\s*import\s/m);
  });

  it("talks only to the editor's own HTTP API", () => {
    for (const source of [page, view]) {
      for (const detail of ["models.ts", "--json", "--schema", "--validate", "RALPH_LOOP_NAME", "child_process"]) {
        expect(source).not.toContain(detail);
      }
    }
    expect(view).toContain('"/api/lineup"');
    expect(view).toContain('"/api/lineup/edit"');
    expect(view).toContain('"/api/lineup/save"');
  });
});

describe("no capability map or alias list is hardcoded", () => {
  it.each([
    ["page", page],
    ["view helpers", view],
  ])("the %s spell no alias and no single-stage harness", (_name, source) => {
    for (const literal of ["opus", "sonnet", "haiku", "fable", "opencode", "codex"]) {
      expect(source.toLowerCase()).not.toContain(literal);
    }
  });

  it("reads runners, aliases and the model-id rules from the schema", () => {
    expect(view).toMatch(/schema\.runnersFor/);
    expect(view).toMatch(/schema\.aliases/);
    expect(view).toMatch(/schema\.agentToolStages/);
    expect(view).toMatch(/schema\.modelId\.pattern/);
    expect(view).toMatch(/schema\.modelId\.providerPrefix/);
  });
});

describe("the page's copy", () => {
  it("states the apply timing and points at the loop controls rather than restarting", () => {
    expect(page).toContain("APPLY_TIMING");
    expect(page).toMatch(/loop controls/i);
    expect(page).not.toMatch(/\/api\/control|restart-to-apply|orchestration/);
  });

  it("declares each top-level function once", () => {
    const names = [...page.matchAll(/^ {6}(?:async )?function ([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]!);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });
});
