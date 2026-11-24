// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { scratchDir } from "../test-scratch";
import { subprocessSuite } from "../test-timeouts";
import { secretSourceContract } from "./contract";
import { dotenvSource, DotenvSyntaxError, parseDotenv, readDotenvFile } from "./dotenv";
import { secretSourceFor } from "./source";

subprocessSuite("bash secrets/dotenv-run.sh, which spawns bun secrets/dotenv.ts");

const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
const RUN = join(import.meta.dirname, "dotenv-run.sh");

/** A value written double-quoted, escaped so it reads back exactly. */
const quoted = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;

/** A dotenv file in a scratch directory holding `text`. */
const envFile = (text: string): string => {
  const path = join(scratchDir("ralph-dotenv-"), "secrets.env");
  writeFileSync(path, text);
  return path;
};

secretSourceContract("dotenv", {
  kind: "dotenv",
  // A file is read whole: it cannot fail one name and hold the next.
  supportsUnread: false,
  make: ({ stored }) =>
    dotenvSource(
      envFile(
        Object.entries(stored)
          .map(([name, value]) => `${name}=${quoted(value)}\n`)
          .join(""),
      ),
    ),
});

const SECRET = "sk_live_never_in_an_error";

describe("parseDotenv", () => {
  it("skips blank and comment lines and takes an optional export", () => {
    const vars = parseDotenv("# a comment\n\n   \nexport ONE=1\nTWO=2\n  # indented comment\n");
    expect([...vars]).toEqual([
      ["ONE", "1"],
      ["TWO", "2"],
    ]);
  });

  it("trims an unquoted value and cuts a ' #' comment, but not an inner #", () => {
    const vars = parseDotenv("A=  spaced value   # note\nB=a#b\nC=\n");
    expect(vars.get("A")).toBe("spaced value");
    expect(vars.get("B")).toBe("a#b");
    expect(vars.get("C")).toBe("");
  });

  it("reads a value that is only a comment as empty", () => {
    const vars = parseDotenv("A=   # fill me in\nB=#\n");
    expect(vars.get("A")).toBe("");
    expect(vars.get("B")).toBe("");
  });

  it("keeps a single-quoted value literal", () => {
    expect(parseDotenv("A=' x\\n #y '  # c\n").get("A")).toBe(" x\\n #y ");
  });

  it("unescapes a double-quoted value and lets it span lines", () => {
    const vars = parseDotenv('A="a\\nb\\tc\\"d\\\\e"\nB="line one\nline two"\nC=after\n');
    expect(vars.get("A")).toBe('a\nb\tc"d\\e');
    expect(vars.get("B")).toBe("line one\nline two");
    expect(vars.get("C")).toBe("after");
  });

  it("lets a later duplicate win", () => {
    expect(parseDotenv("A=first\nA=second\n").get("A")).toBe("second");
  });

  it("reads CRLF line endings", () => {
    expect([...parseDotenv("A=1\r\nB=2\r\n")]).toEqual([
      ["A", "1"],
      ["B", "2"],
    ]);
  });

  it.each([
    ["no '='", `OK=1\n${SECRET}\n`, 2],
    ["a bad key", `OK=1\n\n1BAD=${SECRET}\n`, 3],
    ["an unclosed double quote", `A="${SECRET}\n`, 1],
    ["an unclosed single quote", `A='${SECRET}\n`, 1],
  ])("names only the line number for %s", (_what, text, line) => {
    let error: unknown;
    try {
      parseDotenv(text);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DotenvSyntaxError);
    const message = (error as Error).message;
    expect(message.startsWith(`line ${line}:`)).toBe(true);
    expect(message.includes(SECRET)).toBe(false);
  });
});

describe("readDotenvFile", () => {
  it("reads a file", () => {
    const read = readDotenvFile(envFile("A=1\n"));
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") expect(read.vars.get("A")).toBe("1");
  });

  it("answers missing for no file and for no path", () => {
    expect(readDotenvFile(join(scratchDir("ralph-dotenv-"), "nope.env"))).toEqual({ kind: "missing" });
    expect(readDotenvFile("")).toEqual({ kind: "missing" });
  });

  it.skipIf(process.getuid?.() === 0)("answers unreadable for a file it may not read", () => {
    const path = envFile(`A=${SECRET}\n`);
    chmodSync(path, 0o000);
    const read = readDotenvFile(path);
    expect(read.kind).toBe("unreadable");
    expect(JSON.stringify(read).includes(SECRET)).toBe(false);
  });

  it("answers malformed without the line's text", () => {
    const read = readDotenvFile(envFile(`${SECRET}\n`));
    expect(read).toEqual({ kind: "malformed", why: "line 1: no '=' in the assignment" });
  });
});

describe("dotenv secret source", () => {
  it("reads unread, naming the file, when the file is missing", async () => {
    const path = join(scratchDir("ralph-dotenv-"), "nope.env");
    const read = await dotenvSource(path).read("API_TOKEN");
    if (read.kind !== "unread") throw new Error(`not unread: ${read.kind}`);
    expect(read.why).toContain(path);
  });

  it("reads unread when the file is malformed, with no value in the reason", async () => {
    const read = await dotenvSource(envFile(`GOOD=${SECRET}\nBAD\n`)).read("GOOD");
    expect(read.kind).toBe("unread");
    expect(JSON.stringify(read).includes(SECRET)).toBe(false);
  });

  it("reads a blank value as absent", async () => {
    const source = dotenvSource(envFile('EMPTY=\nBLANK="  "\n'));
    expect(await source.read("EMPTY")).toEqual({ kind: "absent" });
    expect(await source.read("BLANK")).toEqual({ kind: "absent" });
  });

  it("is what the dotenv runner reads through, from RALPH_SECRETS_FILE", async () => {
    const source = secretSourceFor("dotenv", { RALPH_SECRETS_FILE: envFile("TOKEN=tok\n") });
    expect(source.kind).toBe("dotenv");
    expect(await source.read("TOKEN")).toEqual({ kind: "value", value: "tok" });
    expect((await secretSourceFor("dotenv", {}).read("TOKEN")).kind).toBe("unread");
  });
});

describe("bash secrets/dotenv-run.sh", () => {
  /** The wrapper as `ralph.sh` runs it, with bun on PATH and `env` besides. */
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [RUN, ...args], {
      encoding: "utf8",
      env: { PATH: `${join(BUN, "..")}:${process.env.PATH ?? ""}`, ...env },
      timeout: 25_000,
    });

  it("runs the command with the file's variables, overriding the environment", () => {
    const file = envFile(`A=from_file\nexport B="two\\nlines"\nC='  kept  '\n`);
    const out = run([file, "--", "bash", "-c", 'printf "%s|%s|%s" "$A" "$B" "$C"'], { A: "from_env" });
    expect(out.status).toBe(0);
    expect(out.stdout).toBe("from_file|two\nlines|  kept  ");
  });

  it("keeps a variable the file does not name", () => {
    const out = run([envFile("A=1\n"), "--", "bash", "-c", 'printf "%s" "$KEEP"'], { KEEP: "kept" });
    expect(out.stdout).toBe("kept");
  });

  it("exits 3 and runs nothing when the file is missing", () => {
    const dir = scratchDir("ralph-dotenv-");
    const file = join(dir, "nope.env");
    const marker = join(dir, "ran");
    const out = run([file, "--", "bash", "-c", `touch ${marker}; echo ${SECRET}`]);
    expect(out.status).toBe(3);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain(file);
    expect(out.stderr).toContain("missing");
    expect(out.stderr.includes(SECRET)).toBe(false);
    expect(spawnSync("test", ["-e", marker]).status).not.toBe(0);
  });

  it("exits 5 and runs nothing when the file is malformed, with no value on stderr", () => {
    const out = run([envFile(`GOOD=${SECRET}\nBAD LINE\n`), "--", "bash", "-c", "echo ran"]);
    expect(out.status).toBe(5);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("malformed");
    expect(out.stderr.includes(SECRET)).toBe(false);
  });

  it("exits 2 on a usage error", () => {
    expect(run([]).status).toBe(2);
    expect(run([envFile("A=1\n"), "bash"]).status).toBe(2);
    expect(run([envFile("A=1\n"), "--"]).status).toBe(2);
  });
});
