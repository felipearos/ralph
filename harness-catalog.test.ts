// @vitest-environment node
/**
 * The catalogue is read from the harnesses themselves, through fakes on PATH
 * and a scratch Codex home, and each unavailable harness is reported as such
 * rather than as an empty list.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  claudeBinaryCandidates,
  parseClaudeCatalog,
  parseClaudeEfforts,
  parseCodexCache,
  readClaudeLatest,
  scanLatestPerFamily,
} from "./harness-catalog";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs the harness catalog through bash and bun");

const CLI = join(__dirname, "harness-catalog.ts");
const scratch: string[] = [];
afterAll(() => scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const bun = (): string => {
  try {
    return execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
  } catch {
    return process.execPath;
  }
};

const HELP = [
  "Options:",
  "  --effort <level>                      Effort level for the current session",
  "                                        (low, medium, high, xhigh, max)",
  "  --model <model>                       Model for the current session. Provide",
  "                                        an alias for the latest model (e.g.",
  "                                        'fable', 'opus', or 'sonnet') or a",
  "                                        model's full name (e.g.",
  "                                        'claude-fable-5').",
].join("\n");

/** A slice shaped like the minified catalog the Claude Code binary bakes in. */
const BAKED =
  'var x=[{id:"claude-test-4",family:"test",display_name:"Test 4",provider_ids:{first_party:"claude-test-4"},' +
  'context:{window:200000},capabilities:["context_management"],advisor_rank:1},' +
  '{id:"claude-test-5",family:"test",display_name:"Test 5",provider_ids:{first_party:"claude-test-5"},' +
  'context:{window:1e6,native_1m:!0},capabilities:["effort","max_effort","xhigh_effort","adaptive_thinking"],' +
  'default_effort:"high",advisor_rank:2}],aliases:{test:{default:"claude-test-5"}},' +
  'latest_per_family:{test:"claude-test-5",other:"claude-other-1"},alias_migration:{};' +
  // The same records appear more than once in the binary; they must not repeat.
  '{id:"claude-test-5",family:"test",display_name:"Test 5",context:{window:1e6},capabilities:["effort"],advisor_rank:2}';

describe("parsing what the harnesses expose", () => {
  it("reads Claude Code's effort levels from its help text", () => {
    expect(parseClaudeEfforts(HELP)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(parseClaudeEfforts("no such flag")).toEqual([]);
  });

  it("reads the baked model catalog out of the Claude Code binary, newest first", () => {
    expect(parseClaudeCatalog(BAKED)).toEqual({
      models: [
        { id: "claude-test-5", label: "Test 5", efforts: ["low", "medium", "high", "xhigh", "max"], contextWindow: 1e6 },
        { id: "claude-test-4", label: "Test 4", contextWindow: 200000 },
      ],
      aliases: { test: "claude-test-5", other: "claude-other-1" },
    });
    expect(parseClaudeCatalog("nothing here")).toEqual({ models: [], aliases: {} });
  });

  it("keeps only the visible Codex models, with their reasoning levels", () => {
    const cache = JSON.stringify({
      models: [
        { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }] },
        { slug: "gpt-reserve", visibility: "hide", supported_reasoning_levels: [{ effort: "ultra" }] },
        { slug: "gpt-5.5", visibility: "list", upgrade: { model: "gpt-6-astra" } },
      ],
    });
    expect(parseCodexCache(cache)).toEqual({
      models: [
        { id: "gpt-6-astra", label: "GPT-6-Astra", efforts: ["low", "max"] },
        { id: "gpt-5.5", upgradeTo: "gpt-6-astra" },
      ],
      efforts: ["low", "max"],
    });
  });
});

describe("the CLI against fake harnesses", () => {
  it("asks each harness and reports the one that is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-catalog-"));
    scratch.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const fake = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    // The fake `claude` carries a baked catalog in a comment, the way the real
    // binary carries one in its bundle; the reader finds it by shape.
    fake(
      "claude",
      `# ${BAKED}\ncase "$1" in --help) cat <<'EOF'\n${HELP}\nEOF\n;; --version) echo "9.9.9 (Claude Code)";; esac`,
    );
    fake("opencode", `case "$1" in models) printf '%s\\n' 'opencode-go/deepseek-v4-flash' 'opencode/big-pickle' 'not a model';; --version) echo 1.0.0;; esac`);
    // No `codex` on PATH and no cache: the runner is unavailable with a reason.
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome);
    const out = execFileSync(bun(), [CLI, "--json"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, CODEX_HOME: codexHome },
    });
    const catalog = JSON.parse(out) as {
      runners: Record<
        string,
        { available: boolean; reason: string | null; models: { id: string; label?: string }[]; efforts: string[]; version: string | null; aliases?: Record<string, string> }
      >;
    };
    expect(catalog.runners.claude).toMatchObject({
      available: true,
      version: "9.9.9 (Claude Code)",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      aliases: { test: "claude-test-5", other: "claude-other-1" },
    });
    expect(catalog.runners.claude!.models.map((model) => model.id)).toEqual(["test", "other", "claude-test-5", "claude-test-4"]);
    expect(catalog.runners.claude!.models[0]).toEqual({ id: "test", label: "alias for claude-test-5" });
    expect(catalog.runners.opencode!.models.map((model) => model.id)).toEqual(["opencode-go/deepseek-v4-flash", "opencode/big-pickle"]);
    expect(catalog.runners.codex).toMatchObject({ available: false, models: [] });
    expect(catalog.runners.codex!.reason).toMatch(/models_cache\.json/);
  });
});

describe("finding the binary behind a wrapper", () => {
  /** A PATH whose `claude` is a wrapper script, and a native install holding builds. */
  const host = (builds: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "ralph-catalog-wrapper-"));
    scratch.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexec \"$HOME/.local/share/claude/versions/2.10.0\" \"$@\"\n");
    chmodSync(join(bin, "claude"), 0o755);
    const versions = join(root, "home", ".local", "share", "claude", "versions");
    mkdirSync(versions, { recursive: true });
    for (const [name, body] of Object.entries(builds)) writeFileSync(join(versions, name), body);
    return { root, bin, home: join(root, "home"), versions };
  };

  it("tries the PATH entry first, then the newest installed build by version, not by name", () => {
    const { bin, home, versions } = host({ "2.9.0": "", "2.10.0": "", "notes.txt": "" });
    expect(claudeBinaryCandidates({ PATH: bin, HOME: home })).toEqual([join(bin, "claude"), join(versions, "2.10.0")]);
  });

  it("reads latest_per_family from the build when the PATH entry is a wrapper", () => {
    const { bin, home, versions } = host({ "2.10.0": BAKED });
    expect(readClaudeLatest({ PATH: bin, HOME: home })).toEqual({
      latest: { test: "claude-test-5", other: "claude-other-1" },
      source: join(versions, "2.10.0"),
    });
  });

  it("answers null when no candidate carries the map", () => {
    const { bin, home } = host({ "2.10.0": "no catalog in this build" });
    expect(readClaudeLatest({ PATH: bin, HOME: home })).toBeNull();
    expect(readClaudeLatest({ PATH: "", HOME: join(home, "nowhere") })).toBeNull();
  });

  it("reads a map that straddles the scanner's chunk boundary", () => {
    const { root } = host({});
    const file = join(root, "big");
    const map = 'latest_per_family:{opus:"claude-opus-9-1",haiku:"claude-haiku-9"}';
    // The scanner reads 8 MiB at a time; the anchor starts a few bytes before
    // the first boundary, so neither it nor its closing brace is in one chunk.
    const pad = 8 * 1024 * 1024 - 10;
    writeFileSync(file, Buffer.concat([Buffer.alloc(pad, 0x20), Buffer.from(map, "latin1"), Buffer.alloc(64, 0x20)]));
    expect(scanLatestPerFamily(file)).toEqual({ opus: "claude-opus-9-1", haiku: "claude-haiku-9" });
  });

  it("skips an anchor with no map after it, and does not carry it to the end of the file", () => {
    const { root } = host({});
    const file = join(root, "stray");
    // A stray anchor, 64 KiB of nothing, then the real map past the first chunk.
    writeFileSync(
      file,
      Buffer.concat([
        Buffer.from("latest_per_family:{", "latin1"),
        Buffer.alloc(9 * 1024 * 1024, 0x20),
        Buffer.from('latest_per_family:{opus:"claude-opus-9-1"}', "latin1"),
      ]),
    );
    expect(scanLatestPerFamily(file)).toEqual({ opus: "claude-opus-9-1" });
  });

  it("the CLI reads the catalog out of the installed build behind a wrapper", () => {
    const { bin, home } = host({ "2.10.0": BAKED });
    writeFileSync(join(bin, "claude"), `#!/bin/sh\ncase "$1" in --help) cat <<'EOF'\n${HELP}\nEOF\n;; --version) echo "2.10.0 (Claude Code)";; esac\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const out = execFileSync(bun(), [CLI, "--json"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: home, CODEX_HOME: join(home, "codex") },
    });
    const claude = (JSON.parse(out) as { runners: { claude: { available: boolean; source: string; aliases?: Record<string, string> } } }).runners.claude;
    expect(claude.available).toBe(true);
    expect(claude.source).toMatch(/versions\/2\.10\.0: baked model catalog$/);
    expect(claude.aliases).toEqual({ test: "claude-test-5", other: "claude-other-1" });
  });
});
