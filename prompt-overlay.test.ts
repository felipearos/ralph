import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { applyOverlay, readOverlay } from "./prompt-overlay";
import { scratchDir } from "./test-scratch";

function overlay(files: Record<string, string>): string {
  const dir = scratchDir("overlay-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("readOverlay", () => {
  it("lists the prompt files it replaces, sorted, with a hash of their content", () => {
    const dir = overlay({ "coder.md": "short coder", "prompts/triager.md": "triage", "prompt.md": "main" });
    const read = readOverlay(dir);
    expect(read.files).toEqual(["coder.md", "prompt.md", "prompts/triager.md"]);
    expect(read.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(readOverlay(overlay({ "prompt.md": "main", "prompts/triager.md": "triage", "coder.md": "short coder" })).hash).toBe(read.hash);
    expect(readOverlay(overlay({ "coder.md": "other", "prompts/triager.md": "triage", "prompt.md": "main" })).hash).not.toBe(read.hash);
  });

  it("refuses anything that is not a harness prompt file, naming it", () => {
    expect(() => readOverlay(overlay({ "ralph.sh": "exit 0" }))).toThrow(/ralph\.sh is not a prompt file/);
    expect(() => readOverlay(overlay({ "prompts/x.ts": "x" }))).toThrow(/prompts\/x\.ts is not a prompt file/);
    expect(() => readOverlay(overlay({ "README.md": "x" }))).toThrow(/README\.md is not a prompt file/);
  });

  it("refuses a symlink, an empty overlay and a missing directory", () => {
    const dir = overlay({ "coder.md": "x" });
    symlinkSync("/etc/passwd", join(dir, "prompt.md"));
    expect(() => readOverlay(dir)).toThrow(/prompt\.md is a symlink/);
    expect(() => readOverlay(scratchDir("overlay-empty-"))).toThrow(/replaces no prompt file/);
    expect(() => readOverlay("/nonexistent/overlay")).toThrow(/no overlay directory/);
  });
});

describe("applyOverlay", () => {
  it("replaces only the overlay's files in the staged harness", () => {
    const harness = overlay({ "coder.md": "live coder", "prompt.md": "live prompt", "ralph.sh": "real" });
    applyOverlay(overlay({ "coder.md": "candidate coder" }), harness);
    expect(readFileSync(join(harness, "coder.md"), "utf8")).toBe("candidate coder");
    expect(readFileSync(join(harness, "prompt.md"), "utf8")).toBe("live prompt");
    expect(readFileSync(join(harness, "ralph.sh"), "utf8")).toBe("real");
  });

  it("refuses a file the harness does not have, so a typo never adds a prompt nobody reads", () => {
    const harness = overlay({ "coder.md": "live" });
    expect(() => applyOverlay(overlay({ "prompts/coderr.md": "x" }), harness)).toThrow(/prompts\/coderr\.md is not in the harness/);
  });
});
