/**
 * Content tokens → Markdown projection (SCHEMA.md owed work "Content
 * serialization for export", §34.12 Tier 2 conventions).
 *
 * The op log is the truth; this is a lossy, human-facing projection:
 * UUID filenames, YAML frontmatter (name/classes/properties), `[[mentions]]`,
 * `#class-chips`, `![[uuid]]` embeds, fenced ```query / ```json whiteboard
 * blocks, and a workspace UUID↔name↔type manifest (bundle.ts).
 *
 * Token → Markdown mapping (M1, deliberately simple):
 *
 *  | Token         | Markdown                                              |
 *  |---------------|-------------------------------------------------------|
 *  | text          | verbatim; marks wrap in fixed order (outer→inner):     |
 *  |               |   bold `**` → italic `*` → strike `~~` →              |
 *  |               |   highlight `==` → code `` ` `` (innermost)            |
 *  | hard_break    | newline (line jump)                                   |
 *  | mention       | `[[name]]` — displayText ?? ctx.nameOf(target) ?? raw id    |
 *  |               |   (broken targets render the id; SCHEMA Fork 4)         |
 *  | class_chip    | `#name` — displayText ?? ctx.nameOf(class) ?? raw id;  |
 *  |               |   whitespace collapsed to `-`                         |
 *  | typed_link    | `**verb** text (locator)` — verb string, or bound      |
 *  |               |   propertySchemaId resolved via ctx.nameOf; locator   |
 *  |               |   from metadata.locator, plain parentheses            |
 *  | asset_ref     | `![asset](<uuid>)`                                    |
 *  | embed_ref     | `![[uuid]]`                                           |
 *  | external_link | `[text](href)`                                        |
 *  | math          | `$expression$`                                        |
 *  | quote         | `> ` prefix per rendered line (children inline)        |
 *  | query         | fenced ```query block, pretty-printed QueryAST JSON   |
 *  | whiteboard    | fenced ```json block with the layout (M1: inline —    |
 *  |               |   no sidecar files yet)                                |
 *
 * Known M1 simplifications (documented, not accidental): text runs are
 * emitted verbatim (no Markdown-metacharacter escaping), and block-scale
 * tokens (asset_ref/embed_ref/query/whiteboard) always render as their own
 * paragraph. The package is pure/IO-free: name and child resolution are
 * injected via ExportContext.
 */

import type { ContentAst, ContentToken, InlineToken } from "@notees/protocol";
import type { NodeType } from "@notees/domain";
import { deriveDisplayName } from "@notees/domain";

/** A property value as projected by the object API (SCHEMA.md property rows). */
export interface ExportPropertyValue {
  schemaId: string;
  schemaName: string;
  value: unknown;
  /** Per-value qualifiers (e.g. `{ since: 1962 }`) rendered `value (since 1962)`. */
  metadata?: Record<string, unknown> | undefined;
}

/** The node shape the exporter needs — satisfied by the object-API full object. */
export interface ExportNode {
  id: string;
  nodeType: NodeType;
  name: string | null;
  contentAst: ContentAst;
  classIds: string[];
  properties: ExportPropertyValue[];
}

/**
 * Injected resolution surface — keeps this package pure and IO-free.
 * `nameOf` resolves node/class/property-schema ids to their current display
 * name (rename-free: mentions render the target's CURRENT name, SCHEMA Fork 4).
 * `childrenOf` provides direct children for nested-bullet rendering.
 */
export interface ExportContext {
  nameOf(id: string): string | undefined;
  childrenOf?(id: string): ExportNode[] | undefined;
}

/** Recursion guard for children nesting (embed-style cycles in the tree). */
const MAX_CHILD_DEPTH = 24;

const BLOCK_SCALE_TYPES = new Set(["asset_ref", "embed_ref", "query", "whiteboard"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- YAML frontmatter ---------------------------------------------------------

/** Plain-scalar safe subset; anything else is emitted as a JSON (YAML double-quoted) string. */
const YAML_PLAIN = /^[A-Za-z0-9][A-Za-z0-9 ._/@()+\-]*$/;
const YAML_RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);

function yamlScalar(value: string): string {
  if (YAML_PLAIN.test(value) && !YAML_RESERVED.has(value.toLowerCase())) return value;
  return JSON.stringify(value);
}

function yamlKey(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_ -]*$/.test(name) ? name : JSON.stringify(name);
}

function renderPropertyValue(property: ExportPropertyValue, ctx: ExportContext): string {
  const value = property.value;
  let base: string;
  if (typeof value === "string") base = value;
  else if (typeof value === "number" || typeof value === "boolean") base = String(value);
  else if (value === null) base = "null";
  else if (isRecord(value) && typeof value.nodeId === "string") {
    base = ctx.nameOf(value.nodeId) ?? value.nodeId;
  } else {
    base = JSON.stringify(value);
  }
  const metadata = property.metadata;
  if (metadata !== undefined && Object.keys(metadata).length > 0) {
    const qualifiers = Object.entries(metadata)
      .map(([key, entry]) => `${key} ${String(entry)}`)
      .join(", ");
    base = `${base} (${qualifiers})`;
  }
  return base;
}

function renderFrontmatter(node: ExportNode, ctx: ExportContext): string {
  const lines: string[] = ["---"];
  const title = deriveDisplayName(node);
  if (title.length > 0) lines.push(`name: ${yamlScalar(title)}`);
  lines.push(`nodeType: ${node.nodeType}`);
  if (node.classIds.length > 0) {
    lines.push("classIds:");
    for (const classId of node.classIds) lines.push(`  - ${yamlScalar(classId)}`);
  }
  if (node.properties.length > 0) {
    const bySchema = new Map<string, ExportPropertyValue[]>();
    for (const property of node.properties) {
      const list = bySchema.get(property.schemaName);
      if (list === undefined) bySchema.set(property.schemaName, [property]);
      else list.push(property);
    }
    lines.push("properties:");
    for (const [schemaName, values] of bySchema) {
      if (values.length === 1) {
        const only = values[0];
        if (only === undefined) continue;
        lines.push(`  ${yamlKey(schemaName)}: ${yamlScalar(renderPropertyValue(only, ctx))}`);
      } else {
        lines.push(`  ${yamlKey(schemaName)}:`);
        for (const value of values) lines.push(`    - ${yamlScalar(renderPropertyValue(value, ctx))}`);
      }
    }
  }
  lines.push("---");
  return lines.join("\n");
}

// --- content tokens ------------------------------------------------------------

function renderMarkedText(text: string, marks: readonly string[] | undefined): string {
  if (marks === undefined || marks.length === 0) return text;
  let out = text;
  // Fixed nesting order — innermost first: code, highlight, strike, italic, bold.
  if (marks.includes("code")) out = `\`${out.replace(/`/g, "'")}\``;
  if (marks.includes("highlight")) out = `==${out}==`;
  if (marks.includes("strike")) out = `~~${out}~~`;
  if (marks.includes("italic")) out = `*${out}*`;
  if (marks.includes("bold")) out = `**${out}**`;
  return out;
}

function renderVerb(verb: unknown, ctx: ExportContext): string {
  if (typeof verb === "string") return verb;
  if (isRecord(verb) && typeof verb.propertySchemaId === "string") {
    return ctx.nameOf(verb.propertySchemaId) ?? verb.propertySchemaId;
  }
  return String(verb);
}

function renderInlineToken(token: InlineToken, ctx: ExportContext): string {
  switch (token.type) {
    case "text":
      return renderMarkedText(token.text, token.marks);
    case "hard_break":
      return "\n";
    case "mention": {
      const name = token.displayText ?? ctx.nameOf(token.targetNodeId) ?? token.targetNodeId;
      return `[[${name}]]`;
    }
    case "class_chip": {
      const name = token.displayText ?? ctx.nameOf(token.classId) ?? token.classId;
      return `#${name.replace(/\s+/g, "-").replace(/^#+/, "")}`;
    }
    case "typed_link": {
      const locator = token.metadata?.locator;
      return `**${renderVerb(token.verb, ctx)}** ${token.text}${locator !== undefined ? ` (${locator})` : ""}`;
    }
    case "external_link":
      return `[${token.text}](${token.href})`;
    case "math":
      return `$${token.expression}$`;
    default:
      return "";
  }
}

function renderBlockScaleToken(token: ContentToken, ctx: ExportContext): string {
  switch (token.type) {
    case "asset_ref":
      return `![asset](<${token.assetId}>)`;
    case "embed_ref":
      return `![[${token.nodeId}]]`;
    case "query":
      return "```query\n" + JSON.stringify(token.queryAst, null, 2) + "\n```";
    case "whiteboard":
      return "```json\n" + JSON.stringify(token.layout, null, 2) + "\n```";
    default:
      return renderInlineToken(token as InlineToken, ctx);
  }
}

/**
 * Render a token stream to Markdown lines: inline-scale tokens accumulate on
 * one line, block-scale tokens flush the line and get their own paragraph.
 */
export function renderContent(ast: ContentAst | null | undefined, ctx: ExportContext): string {
  if (ast === null || ast === undefined) return "";
  const out: string[] = [];
  let line = "";
  const flush = () => {
    if (line.trim().length > 0) out.push(line);
    line = "";
  };
  for (const token of ast) {
    if (token.type === "quote") {
      flush();
      const inner = token.children.map((child) => renderInlineToken(child, ctx)).join("");
      out.push(
        inner
          .split("\n")
          .map((text) => `> ${text}`.trimEnd())
          .join("\n"),
      );
    } else if (BLOCK_SCALE_TYPES.has(token.type)) {
      flush();
      out.push(renderBlockScaleToken(token, ctx));
    } else {
      line += renderInlineToken(token as InlineToken, ctx);
    }
  }
  flush();
  return out.join("\n");
}

// --- children (nested bullets) ---------------------------------------------------

function renderChildBullets(
  id: string,
  ctx: ExportContext,
  depth: number,
  visited: ReadonlySet<string>,
): string[] {
  if (depth >= MAX_CHILD_DEPTH || ctx.childrenOf === undefined) return [];
  const children = ctx.childrenOf(id);
  if (children === undefined || children.length === 0) return [];
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  for (const child of children) {
    if (visited.has(child.id)) {
      lines.push(`${indent}- ![[${child.id}]]`);
      continue;
    }
    const nextVisited = new Set(visited);
    nextVisited.add(child.id);
    const content = renderContent(child.contentAst, ctx);
    const contentLines = content.length > 0 ? content.split("\n") : [""];
    const first = contentLines[0] ?? "";
    lines.push(`${indent}- ${first}`.trimEnd());
    for (const rest of contentLines.slice(1)) {
      lines.push(`${indent}  ${rest}`.trimEnd());
    }
    lines.push(...renderChildBullets(child.id, ctx, depth + 1, nextVisited));
  }
  return lines;
}

// --- node → file -----------------------------------------------------------------

/**
 * Render one node to a standalone Markdown file: YAML frontmatter (name,
 * nodeType, classIds, properties), a `# <title>` heading for page/class files,
 * the rendered content, and — when a children resolver is injected — direct
 * children as nested bullets.
 */
export function nodeToMarkdown(node: ExportNode, ctx: ExportContext): string {
  const parts: string[] = [renderFrontmatter(node, ctx)];
  const title = deriveDisplayName(node);
  if (node.nodeType !== "block") {
    parts.push(`# ${title.length > 0 ? title : node.id}`);
  }
  const body = renderContent(node.contentAst, ctx);
  if (body.length > 0) parts.push(body);
  if (ctx.childrenOf !== undefined) {
    const childLines = renderChildBullets(node.id, ctx, 0, new Set([node.id]));
    if (childLines.length > 0) parts.push(childLines.join("\n"));
  }
  return parts.join("\n\n") + "\n";
}
