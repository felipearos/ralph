/**
 * Atlassian Document Format to and from the markdown the harness reads and
 * writes (felipearos/ralph#337).
 *
 * Jira Cloud's REST v3 carries every description and comment as ADF. The
 * harness's parsers read prose: `## Parent`, `## Blocked by`, checkboxes,
 * `blocked:` lines, the `### Operator decision` heading. So a body comes back
 * as the markdown a person would have typed, and a comment the harness posts
 * goes out as ADF with its headings, lists and code fences as real nodes,
 * which is what makes the round trip read the same on both sides.
 *
 * Only the node types Jira's editor produces for prose are rendered; anything
 * else contributes its text, never nothing, because a dropped node is a
 * dropped `#n` reference.
 */

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

const inline = (nodes: AdfNode[] = []): string =>
  nodes
    .map((node) => {
      switch (node.type) {
        case "text": {
          const text = node.text ?? "";
          return node.marks?.some((mark) => mark.type === "code") ? `\`${text}\`` : text;
        }
        case "hardBreak":
          return "\n";
        case "mention":
          return String(node.attrs?.text ?? "");
        case "inlineCard":
          return String(node.attrs?.url ?? "");
        case "emoji":
          return String(node.attrs?.text ?? node.attrs?.shortName ?? "");
        default:
          return inline(node.content);
      }
    })
    .join("");

function block(node: AdfNode, indent = ""): string {
  switch (node.type) {
    case "paragraph":
      return indent + inline(node.content);
    case "heading":
      return `${"#".repeat(Number(node.attrs?.level ?? 2))} ${inline(node.content)}`;
    case "codeBlock": {
      const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      return `\`\`\`${language}\n${inline(node.content)}\n\`\`\``;
    }
    case "bulletList":
    case "orderedList":
      return (node.content ?? [])
        .map((item, at) => listItem(item, indent, node.type === "orderedList" ? `${at + 1}.` : "-"))
        .join("\n");
    case "taskList":
      return (node.content ?? [])
        .map((item) => `${indent}- [${item.attrs?.state === "DONE" ? "x" : " "}] ${inline(item.content)}`)
        .join("\n");
    case "blockquote":
      return (node.content ?? []).map((child) => `> ${block(child)}`).join("\n");
    case "rule":
      return "---";
    default:
      return node.content ? (node.content ?? []).map((child) => block(child, indent)).join("\n\n") : inline([node]);
  }
}

function listItem(item: AdfNode, indent: string, bullet: string): string {
  const [first, ...rest] = item.content ?? [];
  const head = `${indent}${bullet} ${first ? block(first).trimStart() : ""}`;
  return [head, ...rest.map((child) => block(child, `${indent}  `))].join("\n");
}

/** A description or comment as markdown. Null or a non-document is empty. */
export function adfToMarkdown(doc: unknown): string {
  if (typeof doc === "string") return doc;
  if (typeof doc !== "object" || doc === null) return "";
  const root = doc as AdfNode;
  return (root.content ?? []).map((node) => block(node)).join("\n\n");
}

const textNodes = (line: string): AdfNode[] => (line === "" ? [] : [{ type: "text", text: line }]);

/**
 * Markdown the harness wrote, as ADF. Headings, fenced code, `- ` lists and
 * paragraphs become their nodes; a paragraph's single line breaks become hard
 * breaks, so a multi-line `blocked:` record keeps its lines.
 */
export function markdownToAdf(markdown: string): AdfNode & { version: 1 } {
  const content: AdfNode[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let at = 0;
  while (at < lines.length) {
    const line = lines[at]!;
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      at++;
      while (at < lines.length && !/^```\s*$/.test(lines[at]!)) body.push(lines[at++]!);
      at++;
      content.push({ type: "codeBlock", ...(fence[1] ? { attrs: { language: fence[1] } } : {}), content: textNodes(body.join("\n")) });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      content.push({ type: "heading", attrs: { level: heading[1]!.length }, content: textNodes(heading[2]!) });
      at++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: AdfNode[] = [];
      while (at < lines.length && /^\s*[-*]\s+/.test(lines[at]!)) {
        items.push({ type: "listItem", content: [{ type: "paragraph", content: textNodes(lines[at]!.replace(/^\s*[-*]\s+/, "")) }] });
        at++;
      }
      content.push({ type: "bulletList", content: items });
      continue;
    }
    if (line.trim() === "") {
      at++;
      continue;
    }
    const paragraph: string[] = [];
    while (at < lines.length && lines[at]!.trim() !== "" && !/^(```|#{1,6}\s|\s*[-*]\s+)/.test(lines[at]!)) paragraph.push(lines[at++]!);
    content.push({
      type: "paragraph",
      content: paragraph.flatMap((text, index) => (index === 0 ? textNodes(text) : [{ type: "hardBreak" }, ...textNodes(text)])),
    });
  }
  return { type: "doc", version: 1, content };
}
