// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { hostTestWorkers, maxTestWorkers } from "./test-workers";

describe("the Vitest worker cap", () => {
  it("keeps the Vitest default (cores - 1) on an idle host, so an idle run is no slower", () => {
    expect(maxTestWorkers({ cpus: 16, load1: 0 })).toBe(15);
    expect(maxTestWorkers({ cpus: 16, load1: 0.9 })).toBe(15);
    expect(maxTestWorkers({ cpus: 8, load1: 0.2 })).toBe(7);
  });

  it("follows the free cores on a busy host", () => {
    expect(maxTestWorkers({ cpus: 16, load1: 8 })).toBe(8);
    expect(maxTestWorkers({ cpus: 16, load1: 10.5 })).toBe(5);
  });

  it("never drops below a quarter of the cores, however loaded the host", () => {
    expect(maxTestWorkers({ cpus: 16, load1: 40 })).toBe(4);
    expect(maxTestWorkers({ cpus: 16, load1: 74 })).toBe(4);
    expect(maxTestWorkers({ cpus: 2, load1: 40 })).toBe(1);
    expect(maxTestWorkers({ cpus: 1, load1: 0 })).toBe(1);
  });

  it("takes a positive integer RALPH_TEST_MAX_WORKERS as given", () => {
    expect(maxTestWorkers({ cpus: 16, load1: 40, override: "12" })).toBe(12);
    expect(maxTestWorkers({ cpus: 16, load1: 0, override: "2" })).toBe(2);
  });

  it("ignores a malformed override, or a host reading it cannot trust, instead of failing the run", () => {
    for (const override of ["", " ", "0", "-3", "2.5", "many", "NaN"]) {
      expect(maxTestWorkers({ cpus: 16, load1: 0, override })).toBe(15);
    }
    expect(maxTestWorkers({ cpus: 16, load1: Number.NaN })).toBe(15);
    expect(maxTestWorkers({ cpus: Number.NaN, load1: 0 })).toBe(1);
    expect(maxTestWorkers({ cpus: 0, load1: 3 })).toBe(1);
  });

  it("reads RALPH_TEST_MAX_WORKERS from the environment it is given", () => {
    expect(hostTestWorkers({ RALPH_TEST_MAX_WORKERS: "3" })).toBe(3);
    expect(hostTestWorkers({})).toBeGreaterThanOrEqual(1);
  });

  it("is what vitest.config.ts runs with, and the config raises no timeout globally", () => {
    const config = readFileSync(join(import.meta.dirname, "vitest.config.ts"), "utf8");
    expect(config).toMatch(/maxWorkers: hostTestWorkers\(\)/);
    expect(config).not.toMatch(/testTimeout|hookTimeout/);
  });
});
