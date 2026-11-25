import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createUsageBarFileMemory, usageBarMemoryPath } from "./usagebar-memory";

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-usagebar-memory-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("usageBarMemoryPath", () => {
  it("lives under the XDG cache home, else ~/.cache", () => {
    expect(usageBarMemoryPath({ XDG_CACHE_HOME: "/x/cache", HOME: "/home/op" })).toBe("/x/cache/ralph-dashboard/usagebar.json");
    expect(usageBarMemoryPath({ XDG_CACHE_HOME: "relative", HOME: "/home/op" })).toBe("/home/op/.cache/ralph-dashboard/usagebar.json");
    expect(usageBarMemoryPath({ HOME: "/home/op" })).toBe("/home/op/.cache/ralph-dashboard/usagebar.json");
  });
});

describe("createUsageBarFileMemory", () => {
  it("answers null before anything is saved, then what was saved, user-only", () => {
    const path = join(scratch(), "nested", "usagebar.json");
    const memory = createUsageBarFileMemory(path);
    expect(memory.load()).toBeNull();
    const view = { state: "read" as const, readAt: "2026-11-25T00:00:00.000Z", providers: [] };
    memory.save(view);
    expect(memory.load()).toEqual(view);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reads a corrupt file as nothing remembered", () => {
    const path = join(scratch(), "usagebar.json");
    const memory = createUsageBarFileMemory(path);
    memory.save({ state: "read", readAt: "2026-11-25T00:00:00.000Z", providers: [] });
    writeFileSync(path, "{not json");
    expect(memory.load()).toBeNull();
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });
});
