/**
 * The command module's monopoly on writes, pinned statically (#623).
 *
 * Every write the page sends goes through `ui/command-model.ts` /
 * `ui/command.tsx`: one route table, one remote lock, one `{ error, message }`
 * decoder. A view that grows its own `fetch(..., { method: "POST" })`, its own
 * `isRemote()` gate around a button, or its own body-error formatting forks
 * that again, and the remote dashboard drifts from the local one without any
 * test noticing. This parses every UI source with the TypeScript compiler and
 * walks the AST, so comments, JSX text and regex literals cannot hide or fake
 * a hit. Outside the command module it reports:
 *
 * - any object-literal `method` property (`method: x` or shorthand `{ method }`)
 *   whose value is not the string literal GET or HEAD, wherever the object is
 *   built;
 * - any `isRemote()` call beyond the per-file counts pinned below;
 * - a type literal with both `error` and `message` members, or `error` /
 *   `message` read off an `await <x>.json()` result (directly, or through an
 *   identifier initialised from one in the same file).
 *
 * It lives here, not under `ui/`, because it needs node's fs and the UI
 * program deliberately carries no node types. The fixture cases are the
 * deliberately failing inputs that prove each check fires.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const UI_DIR = join(import.meta.dirname, "ui");

/** The command module: the only files allowed to send writes and decode their answers. */
const COMMAND_MODULE = new Set(["command-model.ts", "command.tsx"]);

/**
 * Every caller of `isRemote()`, with how many calls it makes and why. The count
 * is pinned so a new write gate inside an already-listed file fails too.
 */
const IS_REMOTE_ALLOWED: Record<string, { count: number; why: string }> = {
  "command.tsx": { count: 2, why: "the command module: it is the one place a write is locked for the remote" },
  "use-reads.ts": { count: 8, why: "read-side: picks the bridge-status target, skips reads the remote does not serve (the project sleep, the Claude accounts and the model-updates report among them), waits on the hosted versions instead of the stream (#731), and builds a hovered page's preload targets the same way (#739)" },
  "app.tsx": { count: 3, why: "page shell: VerifierSheet and SentinelSheet visibility, and the BridgeBanner" },
  "labels.tsx": { count: 1, why: "read-side: the labels read is one the remote does not relay" },
  "lineup.tsx": { count: 2, why: "read-side: the harness catalog read and its refresh button" },
  "settings.tsx": { count: 1, why: "read-side: the gate run read (and its poll) is local-only, so the remote page never asks for it" },
  "agent-switch.tsx": { count: 1, why: "read-side: a card's Off line reads the local-only rules route, as the Sentinel and Verifier sheets do" },
  "evals.tsx": { count: 1, why: "read-side: a trial's Patch link opens the local-only patch read, so the remote page offers none" },
  "evals-set.tsx": { count: 1, why: "read-side: the edit form reads a case's notes from the local-only case route, so the remote page reads none" },
};

/**
 * Files outside the command module allowed to decode a `{ error, message }`
 * body, with why. Not a view: the shared read layer turns a failed GET into
 * one message for every read, the read-side twin of decodeAnswer.
 */
const ERROR_BODY_ALLOWED: Record<string, string> = {
  "query-reads.ts": "the shared read layer's one failure decoder for every GET, not a per-view formatter",
};

const ROUTE_HINT =
  "route the write through the command module instead: send it with useCommand and lock its button with useCommandAvailability";

/** Every non-test `.ts`/`.tsx` source under the UI directory, as a path relative to it. */
function uiSources(dir: string = UI_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...uiSources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(relative(UI_DIR, path));
    }
  }
  return out.sort();
}

function parse(file: string, text: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/** Every node of a source, depth first. */
function nodes(source: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const at = (source: ts.SourceFile, node: ts.Node): string =>
  `${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${node.getText(source).replace(/\s+/g, " ")}`;

/** The expression under any parentheses, `as`, `satisfies`, `<T>` or `!`, none of which change the value. */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

const nameOf = (name: ts.PropertyName | ts.BindingName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;

/** Every `method` property in an object literal whose value is not a literal GET or HEAD. */
function writeMethods(source: ts.SourceFile): string[] {
  return nodes(source)
    .filter((node) => {
      if (ts.isShorthandPropertyAssignment(node)) return node.name.text === "method";
      if (!ts.isPropertyAssignment(node) || nameOf(node.name) !== "method") return false;
      const value = unwrap(node.initializer);
      const literal = ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value);
      return !(literal && /^(GET|HEAD)$/i.test(value.text));
    })
    .map((node) => at(source, node));
}

/** How many times a source calls `isRemote()`. */
function isRemoteCalls(source: ts.SourceFile): number {
  return nodes(source).filter(
    (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "isRemote",
  ).length;
}

/** True for `await <x>.json()`, under any wrapping that keeps the value. */
function isAwaitedJson(expression: ts.Expression): boolean {
  const value = unwrap(expression);
  if (!ts.isAwaitExpression(value)) return false;
  const call = unwrap(value.expression);
  return ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "json";
}

const ERROR_FIELDS = new Set(["error", "message"]);

/**
 * Every per-view `{ error, message }` decoder in a source: a type literal with
 * both members, or `error`/`message` read off a parsed JSON body. A body is an
 * `await <x>.json()` itself or an identifier initialised from one in the same
 * file, so `err.message` and `result.error.message` never match.
 */
function errorBodyDecoders(source: ts.SourceFile): string[] {
  const all = nodes(source);
  const bodies = new Set<string>();
  for (const node of all) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isAwaitedJson(node.initializer)) {
      bodies.add(node.name.text);
    }
  }
  const isBody = (expression: ts.Expression): boolean => {
    const value = unwrap(expression);
    return (ts.isIdentifier(value) && bodies.has(value.text)) || isAwaitedJson(value);
  };
  const found: ts.Node[] = [];
  for (const node of all) {
    if (ts.isTypeLiteralNode(node)) {
      const members = new Set(node.members.filter(ts.isPropertySignature).map((member) => nameOf(member.name)));
      if (members.has("error") && members.has("message")) found.push(node);
    } else if (ts.isPropertyAccessExpression(node) && ERROR_FIELDS.has(node.name.text) && isBody(node.expression)) {
      found.push(node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isBody(node.initializer) &&
      node.name.elements.some((element) => ERROR_FIELDS.has(nameOf(element.propertyName ?? element.name) ?? ""))
    ) {
      found.push(node);
    }
  }
  return found.map((node) => at(source, node));
}

/** The `isRemote()` callers that break the pinned allowlist, one line each. */
function isRemoteViolations(counts: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [file, count] of Object.entries(counts)) {
    if (count === 0) continue;
    const allowed = IS_REMOTE_ALLOWED[file];
    if (allowed === undefined) {
      out.push(`${file} calls isRemote() ${count}x and is not in the allowlist`);
    } else if (count !== allowed.count) {
      out.push(`${file} calls isRemote() ${count}x, allowlist pins ${allowed.count} (${allowed.why})`);
    }
  }
  return out;
}

const writes = (text: string, file = "fixture.tsx"): string[] => writeMethods(parse(file, text));
const remotes = (text: string, file = "fixture.tsx"): number => isRemoteCalls(parse(file, text));
const decoders = (text: string, file = "fixture.tsx"): string[] => errorBodyDecoders(parse(file, text));

describe("command guard fixtures: each check fires", () => {
  it("reports a single-line POST fetch", () => {
    expect(writes(`await fetch(api("/x"), { method: "POST", body });`)).toHaveLength(1);
  });

  it("reports a multi-line lower-case 'post' fetch", () => {
    expect(writes(`const response = await fetch(\n  api("/x"),\n  {\n    method:\n      'post',\n    body,\n  },\n);`)).toHaveLength(1);
  });

  it("reports a DELETE fetch", () => {
    expect(writes(`fetch(url, { method: "DELETE" });`)).toHaveLength(1);
  });

  it("reports a PUT init built outside the call", () => {
    expect(writes(`const init: RequestInit = { method: "PUT" };\nfetch(url, init);`, "fixture.ts")).toHaveLength(1);
  });

  it("reports a shorthand method", () => {
    expect(writes(`const method = "POST";\nfetch(url, { method });`)).toHaveLength(1);
  });

  it("reports a POST fetch after a regex holding //", () => {
    expect(writes(`s.replace(/^https?:\\/\\//, ""); void fetch(api("/x"), { method: "POST" });`)).toHaveLength(1);
  });

  it("reports a variable and a template method", () => {
    expect(writes("fetch(url, { method: verb });\nfetch(url, { method: `${verb}` });")).toHaveLength(2);
  });

  it("reports an extra isRemote() call in an allowlisted file and any call in an unlisted one", () => {
    const pinned = IS_REMOTE_ALLOWED["lineup.tsx"]!.count;
    const extra = `${"isRemote();\n".repeat(pinned)}const b = <button disabled={isRemote()} />;`;
    expect(isRemoteViolations({ "lineup.tsx": remotes(extra) })).toHaveLength(1);
    expect(isRemoteViolations({ "triage.tsx": remotes(`if (isRemote()) render();`) })).toHaveLength(1);
  });

  it("reports an { error, message } type literal", () => {
    expect(decoders(`const body = (await r.json()) as { error: string; message: string };`, "fixture.ts")).toHaveLength(1);
  });

  it("reports error/message read off a parsed JSON body", () => {
    expect(decoders(`const json = await r.json();\nshow(json.message);`)).toHaveLength(1);
    expect(decoders(`show((await r.json()).message);`)).toHaveLength(1);
    expect(decoders(`const body = (await r.json()) as Answer;\nconst { error } = body;`, "fixture.ts")).toHaveLength(1);
  });
});

describe("command guard fixtures: what must not be reported", () => {
  it("passes a GET fetch and an explicit GET", () => {
    expect(writes(`fetch(url, { cache: "no-store" });`)).toEqual([]);
    expect(writes(`fetch("http://x/y", { method: "GET", credentials: "same-origin" });`)).toEqual([]);
  });

  it("passes writes, isRemote() and body.message that only sit in comments after JSX text with an apostrophe", () => {
    const source = [
      `const V = () => (`,
      `  <p>`,
      `    the PR's state {/* isRemote() */}`,
      `  </p>`,
      `);`,
      `// method: "POST"`,
      `// const json = await r.json(); json.message`,
      `/* fetch(url, { method: "DELETE" }) */`,
    ].join("\n");
    expect(writes(source)).toEqual([]);
    expect(remotes(source)).toBe(0);
    expect(decoders(source)).toEqual([]);
  });

  it("passes Error.message and a decoded CommandError's message", () => {
    expect(decoders(`const show = (err: unknown) => (err instanceof Error ? err.message : String(err));`)).toEqual([]);
    expect(decoders(`const text = result.error.message === "" ? noticeText(result.error) : result.error.message;`)).toEqual([]);
  });
});

describe("command guard over the real UI sources", () => {
  const sources = uiSources().map((file) => ({ file, source: parse(file, readFileSync(join(UI_DIR, file), "utf8")) }));

  it("finds the sources it guards", () => {
    const files = sources.map(({ file }) => file);
    for (const file of ["command-model.ts", "command.tsx", "query-reads.ts", "use-reads.ts", "chat.tsx", "controls.tsx", "agents.tsx"]) {
      expect(files).toContain(file);
    }
  });

  it("sends no write outside the command module", () => {
    const found = sources.filter(({ file }) => !COMMAND_MODULE.has(file)).flatMap(({ source }) => writeMethods(source));
    expect(found, `writes outside the command module; ${ROUTE_HINT}`).toEqual([]);
  });

  it("calls isRemote() only where the allowlist pins it", () => {
    // api.ts defines isRemote; a definition is not a call, so it needs no entry.
    const counts = Object.fromEntries(sources.map(({ file, source }) => [file, isRemoteCalls(source)]));
    expect(isRemoteViolations(counts), `isRemote() is a page-shell or read-side check; for a write, ${ROUTE_HINT}`).toEqual([]);
    // An entry whose caller went away is stale: drop it so it cannot hide a new gate.
    const stale = Object.keys(IS_REMOTE_ALLOWED).filter((file) => (counts[file] ?? 0) === 0);
    expect(stale, "allowlisted files that no longer call isRemote()").toEqual([]);
  });

  it("formats no { error, message } body outside the command module", () => {
    const hits = Object.fromEntries(sources.map(({ file, source }) => [file, errorBodyDecoders(source)]));
    const found = Object.entries(hits)
      .filter(([file]) => !COMMAND_MODULE.has(file) && ERROR_BODY_ALLOWED[file] === undefined)
      .flatMap(([, list]) => list);
    expect(found, "decode a write's answer with decodeAnswer/noticeText from the command module").toEqual([]);
    const stale = Object.keys(ERROR_BODY_ALLOWED).filter((file) => (hits[file] ?? []).length === 0);
    expect(stale, "ERROR_BODY_ALLOWED files that no longer decode an { error, message } body").toEqual([]);
  });
});
