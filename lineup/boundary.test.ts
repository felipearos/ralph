// @vitest-environment node
/**
 * The process boundary and the write surface, pinned statically.
 *
 * The editor's whole reason to be extractable is that it speaks to the Ralph
 * runtime across JSON, never by importing it. This test is the regression guard
 * against that slipping: the editor's imports are an allow-list, no `ralph/*.ts`
 * module is imported, and the adapter names only the `models.ts` flags, the
 * harness catalogue and `model-updates.ts`.
 *
 * It also pins that the one write path is the validated one: the server runs the
 * real file-write only through the adapter, whose `save` validates before it
 * writes, and the handlers hold no filesystem call of their own.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = __dirname;
const source = (name: string): string => readFileSync(join(HERE, name), "utf8");

const IMPORTS = /from\s+["']([^"']+)["']/g;
const importsOf = (text: string): string[] =>
  [...text.matchAll(IMPORTS)].map((match) => match[1]!);

/** The one import set each editor file is allowed, and nothing outside it. */
const ALLOWED: Record<string, string[]> = {
  "contracts.ts": [],
  "config.ts": ["node:fs", "node:path", "node:url", "./contracts"],
  "adapter.ts": [
    "node:child_process",
    "node:fs",
    "node:os",
    "node:path",
    "../lineup-editor",
    "./contracts",
  ],
  "server.ts": ["./adapter", "./assets", "./config", "./contracts"],
  "assets.ts": ["node:fs", "node:url"],
};

describe("the editor imports no ralph TypeScript", () => {
  it.each(Object.entries(ALLOWED))("keeps %s inside its allow-list", (file, allowed) => {
    for (const specifier of importsOf(source(file))) {
      expect(allowed).toContain(specifier);
    }
  });

  it("crosses the process boundary by CLI, not by import", () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(source(file)).not.toMatch(/from\s+["'][^"']*(?:^|\/)models(?:\.ts)?["']/);
      expect(source(file)).not.toMatch(/from\s+["'][^"']*ralph\//);
    }
    // The adapter's only cross-module import is the edit/serialize layer from
    // issue #9 (`../lineup-editor`): it owns `--validate` and the atomic write
    // for a candidate. The adapter still chooses every read/preview/save
    // invocation and the environment it runs under, and owns the JSON contract
    // each command's output is narrowed against.
    expect(source("adapter.ts")).toContain('from "../lineup-editor"');
  });

  it("gives the handlers and their config no ralph/*.ts import at all", () => {
    // Not even a harmless-looking helper such as `../paths`: the HTTP layer is
    // the part that moves first when the editor is extracted.
    for (const file of ["server.ts", "config.ts", "contracts.ts", "assets.ts"]) {
      expect(importsOf(source(file)).filter((specifier) => specifier.startsWith("../"))).toEqual([]);
    }
  });
});

describe("the adapter's command surface", () => {
  it("names the four models.ts flags, the harness catalogue and model-updates, nothing else", () => {
    const text = source("adapter.ts");
    // `--migrate` is the resolver's own one-time move of pre-project loop
    // blocks under `loggd`: models.ts writes it, and it is a no-op once done.
    for (const flag of ['"--json"', '"--schema"', '"--validate"', '"--migrate"']) {
      expect(text).toContain(flag);
    }
    // The catalogue is the one command that is not the resolver: it asks the
    // harnesses what they can run, and it is the only other script named.
    expect(text.match(/script: "([^"]+)"/g)).toEqual([
      'script: "models.ts"',
      'script: "models.ts"',
      'script: "models.ts"',
      'script: "models.ts"',
      'script: "harness-catalog.ts"',
      // Which blocks run an older Claude model, and the operator's answer for
      // one (#851). The answer writes `models.json`, but in the CLI, behind
      // its own guard: the adapter still writes only through the validator.
      'script: "model-updates.ts"',
      'script: "model-updates.ts"',
    ]);
    // Every subprocess goes through the single `exec` helper: a second spawn
    // site is how a command the guard does not know reaches the runtime.
    expect(text.match(/spawn\(/g) ?? []).toHaveLength(1);
    expect(text).not.toMatch(/execFile|execSync|spawnSync/);
  });

  it("starts no command name a lineup surface does not own", () => {
    const text = source("adapter.ts");
    for (const literal of ['"record"', '"claim"', '"pause"', '"stop"', '"approve"', '"deny"']) {
      expect(text).not.toContain(literal);
    }
  });
});

describe("the write path is the validated one", () => {
  it("saves only through the CLI validator and the atomic writer", () => {
    const text = source("adapter.ts");
    // The only file write is the atomic writer; the only rename is inside it.
    expect(text).not.toMatch(/writeFileSync\(modelsPath/);
    expect(text).toContain("writeConfigAtomically(modelsPath(root), text)");
    // In `save`, validation precedes the write.
    expect(text.indexOf("const validation = await validateText(text)")).toBeLessThan(
      text.indexOf("writeConfigAtomically(modelsPath(root), text)"),
    );
  });

  it("gives the handlers no subprocess or filesystem surface at all", () => {
    const text = source("server.ts");
    expect(text).not.toMatch(/child_process|execFile|spawn/);
    expect(text).not.toMatch(/writeFileSync|writeConfigAtomically|readFileSync/);
  });
});
