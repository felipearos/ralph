// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { resetScreenProjectForTests, screenProject, setScreenProject } from "./screen-project";

const host = globalThis as { window?: unknown };
const hadWindow = "window" in host;
const original = host.window;

/** Puts a stub window whose address bar shows `pathname`. */
function addressBar(pathname: string): void {
  host.window = { location: { pathname } };
}

afterEach(() => {
  resetScreenProjectForTests();
  if (hadWindow) host.window = original;
  else delete host.window;
});

describe("screenProject", () => {
  it("returns the recorded project over the address bar", () => {
    addressBar("/p/loggd/loops/rafa");
    setScreenProject("ralph");
    expect(screenProject()).toBe("ralph");
  });

  it("returns a recorded null rather than falling back to the address bar", () => {
    addressBar("/p/loggd/loops/rafa");
    setScreenProject(null);
    expect(screenProject()).toBeNull();
  });

  it("falls back to the address bar until a project is recorded", () => {
    addressBar("/p/loggd/loops/rafa");
    expect(screenProject()).toBe("loggd");
  });

  it("is null with no window and nothing recorded", () => {
    delete host.window;
    expect(screenProject()).toBeNull();
  });
});
