// @vitest-environment node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fileScratchDir } from "../test-scratch";
import { subprocessSuite } from "../test-timeouts";
import { trackerContract, type Seed } from "./contract";
import { createFakeTracker } from "./fake";
import { createLocalTracker, seedLocalTracker, type LocalTrackerFile } from "./local";

subprocessSuite("bun, writing the same local tracker file");

const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
const LOCAL = join(import.meta.dirname, "local.ts");

const scratchDir = (): string => fileScratchDir("ralph-local-tracker-");

/** The seed written straight to a fresh file, in the shape a keyed fake fills its defaults in. */
const seededFile = (seed: Seed): string => {
  const fake = createFakeTracker({
    kind: "local",
    key: "LOC",
    labels: seed.labels,
    issues: seed.issues.map((issue) => ({ ...issue, title: issue.title ?? `Issue ${issue.number}` })),
  });
  const file = join(scratchDir(), "tracker.json");
  const contents: LocalTrackerFile = { version: 1, key: "LOC", labels: [...fake.existingLabels], issues: [...fake.issues.values()] };
  writeFileSync(file, JSON.stringify(contents));
  return file;
};

trackerContract("local, file-backed", {
  kind: "local",
  ref: (number) => `LOC-${number}`,
  movesStates: true,
  openState: "Todo",
  createsLabels: true,
  cancelsAs: "canceled",
  listsPullRequests: true,
  raisesNotFound: false,
  make: (seed) => createLocalTracker({ file: seededFile(seed), key: "LOC", self: seed.self }),
});

/** Run `body` in a separate bun process, with `tracker` a local tracker on `file`. */
const inOtherProcess = (file: string, body: string): void => {
  const script = join(scratchDir(), "other.ts");
  writeFileSync(
    script,
    `import { createLocalTracker } from ${JSON.stringify(LOCAL)};\n` +
      `const tracker = createLocalTracker({ file: ${JSON.stringify(file)}, key: "LOC" });\n${body}\n`,
  );
  const out = spawnSync(BUN, [script], { encoding: "utf8" });
  expect(out.stderr).toBe("");
  expect(out.status).toBe(0);
};

describe("local tracker", () => {
  it("shares its tickets between separate processes", async () => {
    const file = join(scratchDir(), "tracker.json");
    await seedLocalTracker(file, { key: "LOC", labels: ["ralph-wip"], issue: { number: 7, title: "Seeded" } });

    inOtherProcess(file, `await tracker.comment(7, "from the other side");\nawait tracker.claim(7, "ralph-wip");`);
    const tracker = createLocalTracker({ file, key: "LOC" });
    const seen = await tracker.issue(7);
    expect(seen.labels).toEqual(["ralph-wip"]);
    expect(seen.status).toBe("In Progress");
    expect(seen.comments.map((comment) => comment.body)).toEqual(["from the other side"]);

    await tracker.comment(7, "and back");
    await tracker.done(7, "ralph-done");
    inOtherProcess(
      file,
      `const issue = await tracker.issue(7);\n` +
        `if (issue.state !== "closed" || issue.status !== "Done" || !issue.labels.includes("ralph-done") || issue.comments.length !== 2) {\n` +
        `  console.error(JSON.stringify(issue)); process.exit(1);\n}`,
    );
  });

  it("loses no write when separate processes write at once", async () => {
    const file = join(scratchDir(), "tracker.json");
    await seedLocalTracker(file, { key: "LOC", issue: { number: 1, title: "Busy" } });
    const writers = 6;
    const script = join(scratchDir(), "writer.ts");
    writeFileSync(
      script,
      `import { createLocalTracker } from ${JSON.stringify(LOCAL)};\n` +
        `const tracker = createLocalTracker({ file: ${JSON.stringify(file)}, key: "LOC" });\n` +
        `for (let i = 0; i < 5; i++) await tracker.comment(1, \`\${process.argv[2]}:\${i}\`);\n`,
    );
    // Started together, so their read-modify-writes contend for the lock.
    const runs = Array.from({ length: writers }, (_, n) =>
      new Promise<number | null>((done) => spawn(BUN, [script, String(n)], { stdio: "ignore" }).on("exit", done)),
    );
    expect(await Promise.all(runs)).toEqual(Array(writers).fill(0));
    const bodies = (await createLocalTracker({ file, key: "LOC" }).comments(1)).map((comment) => comment.body);
    expect(bodies).toHaveLength(writers * 5);
    expect(new Set(bodies).size).toBe(writers * 5);
  });

  it("breaks a lock left by a holder that died, rather than failing", async () => {
    const file = join(scratchDir(), "tracker.json");
    await seedLocalTracker(file, { key: "LOC", issue: { number: 1, title: "One" } });
    writeFileSync(`${file}.lock`, "4242 dead-holder");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    await createLocalTracker({ file, key: "LOC" }).comment(1, "after the crash");
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("replaces the file atomically and leaves it whole when an op throws", async () => {
    const file = join(scratchDir(), "tracker.json");
    await seedLocalTracker(file, { key: "LOC", issue: { number: 1, title: "One" } });
    const tracker = createLocalTracker({ file, key: "LOC" });
    await tracker.comment(1, "hello");
    await tracker.addLabels(1, ["x"]);
    expect(readdirSync(join(file, "..")).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);

    const before = readFileSync(file, "utf8");
    await expect(tracker.comment(99, "nowhere")).rejects.toThrow(/LOC-99/);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(JSON.parse(before).version).toBe(1);

    // A writer that died between its write and its rename leaves only its temp.
    writeFileSync(`${file}.424242.tmp`, "{ half a tracker");
    expect((await tracker.issue(1)).comments.map((comment) => comment.body)).toEqual(["hello"]);
  });

  it("reads a missing file as empty, and refuses a corrupt one by path", async () => {
    const dir = scratchDir();
    const missing = createLocalTracker({ file: join(dir, "none.json"), key: "LOC" });
    expect(await missing.openIssues()).toEqual([]);
    expect(existsSync(join(dir, "none.json"))).toBe(false);

    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{ not json");
    await expect(createLocalTracker({ file: corrupt, key: "LOC" }).openIssues()).rejects.toThrow(corrupt);
  });

  it("seeds a ticket with its title, body, labels, state and comments", async () => {
    const file = join(scratchDir(), "nested", "tracker.json");
    const comments = [{ body: "first", createdAt: "2026-10-01T00:00:00Z" }];
    await seedLocalTracker(file, {
      key: "LOC",
      issue: { number: 3, title: "Seeded", body: "the body", labels: ["ready-for-agent"], status: "In Progress", comments },
    });
    await seedLocalTracker(file, { issue: { number: 4, title: "Closed one", state: "closed" } });

    const tracker = createLocalTracker({ file, key: "LOC" });
    const issue = await tracker.issue(3);
    expect(issue).toMatchObject({ title: "Seeded", body: "the body", labels: ["ready-for-agent"], state: "open", status: "In Progress" });
    expect(await tracker.comments(3)).toEqual(comments);
    expect(await tracker.issue(4)).toMatchObject({ title: "Closed one", state: "closed", status: "Done" });
    expect(tracker.ref(3)).toBe("LOC-3");
    // A seeded label exists, so it is not created again.
    expect(await tracker.ensureLabels(["ready-for-agent"])).toEqual({ created: [], missing: [] });
  });
});
